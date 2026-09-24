import {
  AmbientLight,
  Box3,
  DirectionalLight,
  GridHelper, LinearFilter,
  NearestFilter,
  NoColorSpace,
  PerspectiveCamera,
  Scene,
  TextureLoader,
  Timer,
  Vector3,
} from 'three'
import { WebGPURenderer } from 'three/webgpu'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { EXRLoader } from 'three/addons/loaders/EXRLoader.js'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { createVatMaterial, syncVatUniforms } from './vat-material.js'
import { createVatStorageMaterial, loadVatStorage, syncVatStorageUniforms } from './vat-storage.js'
import { buildPreview } from './vat-preview.js'

const params = {
  backend: 'texture',
  frames: 30,
  numWraps: 1,
  texHeight: 30,
  wrapMode: 'wrap_crop',
  positionMode: 'offsets',
  normalize: false,
  minOffset: 0,
  maxOffset: 1,
  fps: 24,
  texFilter: 'nearest',
  playing: true,
  reverse: false,
  time: 0,
  step: 1,
  smooth: true,
}

const sources = { mesh: '', positions: '', normals: '', storage: '', storageMeta: '' }
let EXAMPLES = []
let preview = null
let lastPosTex = null
let lastNrmTex = null
const container = document.querySelector('#app')
const overlay = document.querySelector('#overlay')
const overlayText = document.querySelector('#overlay-text')
const statusBox = document.querySelector('#status')
const frameReadout = document.querySelector('#frame-readout')
const exampleSelect = document.querySelector('#example-select')

const renderer = new WebGPURenderer({ antialias: true })
await renderer.init()
renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
renderer.setSize(container.clientWidth, container.clientHeight)
container.appendChild(renderer.domElement)

const scene = new Scene()
scene.add(new GridHelper(10, 20))

const sun = new DirectionalLight(0xffffff, 2.5)
sun.position.set(4, 6, 3)
scene.add(sun)
const ambient = new AmbientLight(0xffffff, .5)
scene.add(ambient)
const camera = new PerspectiveCamera(45, container.clientWidth / container.clientHeight, 0.1, 100)
camera.position.set(4, 3, 6)
const controls = new OrbitControls(camera, renderer.domElement)
controls.target.set(0, 0.5, 0)

addEventListener('resize', () => {
  camera.aspect = container.clientWidth / container.clientHeight
  camera.updateProjectionMatrix()
  renderer.setSize(container.clientWidth, container.clientHeight)
})

let vat = null // { material, uniforms }
let vatRoot = null
let vatMesh = null
let storageSummary = ''

function storagePlaybackSuffix() {
  if (params.backend !== 'storage' || !vat) return ''
  return ` | step x${params.step}${params.smooth ? ' smooth' : ''}`
}

function setStatus(lines) {
  statusBox.textContent = lines.join('\n')
}

function showError(message) {
  overlay.hidden = false
  overlayText.textContent = message
  overlayText.classList.add('error')
}

async function loadTexture(url, { flipY }) {
  const loader = url.toLowerCase().endsWith('.exr') ? new EXRLoader() : new TextureLoader()
  const texture = await loader.loadAsync(url)
  texture.flipY = flipY
  texture.colorSpace = NoColorSpace
  texture.minFilter = texture.magFilter = params.texFilter === "linear" ? LinearFilter : NearestFilter
  texture.needsUpdate = true
  return texture
}

function frameDuration() {
  return params.frames / params.fps
}

async function reloadVat({ frameCamera }) {
  overlay.hidden = false
  overlayText.classList.remove('error')
  overlayText.textContent = 'Loading VAT assets…'
  try {
    const gltf = await new GLTFLoader().loadAsync(sources.mesh)
    const nextMesh = gltf.scene.children.find((child) => child.isMesh)
    if (!nextMesh) throw new Error('No mesh found in the GLB')

    if (vatRoot) scene.remove(vatRoot)
    if (vat) {
      vat.uniforms.posTexture?.value.dispose()
      vat.uniforms.normalTexture?.value.dispose()
      vat.material.dispose()
    }
    const verts = nextMesh.geometry.getAttribute('position').count
    params.time = 0

    if (params.backend === 'storage') {
      if (!sources.storage || !sources.storageMeta) throw new Error('Drop a _vat.bin + _vat.json below (slots 04/05)')
      const { meta, offsets, normals } = await loadVatStorage(sources.storage, sources.storageMeta)
      // Bake ids ride on uv1.x (u = (i+0.5)/V): every split copy of vertex i
      // shares it. If the .bin/.glb come from different bakes the fractions
      // scatter and vertices sample random rows -> spike check, warn loudly.
      const uv1 = nextMesh.geometry.getAttribute('uv1')
      if (!uv1) throw new Error('Mesh has no second UV set (vertex_anim carries the bake ids: re-export the .glb)')
      // ids must be exactly {0..V-1} (splits duplicate, never invent):
      // wrong vertex count -> fractions scatter; wrap layout -> aliasing.
      const seen = new Set()
      let badIds = 0
      for (let i = 0; i < uv1.count; i++) {
        const scaled = uv1.getX(i) * meta.vertexCount
        if (Math.abs((scaled % 1) - 0.5) > 0.02) badIds++
        else seen.add(Math.round(scaled - 0.5))
      }
      var uvWarn = ''
      if (badIds > 0 || seen.size !== meta.vertexCount) {
        uvWarn = `BIN/GLB mismatch: ${badIds} off-grid + ${seen.size}/${meta.vertexCount} ids (re-bake + re-export together)`
        console.warn(uvWarn)
      }
      Object.assign(params, {
        frames: meta.frameCount,
        fps: meta.fps ?? params.fps,
        numWraps: 1,
        positionMode: meta.positionMode ?? 'offsets',
        normalize: meta.normalize ?? false,
        minOffset: meta.minOffset ?? 0,
        maxOffset: meta.maxOffset ?? 1,
      })
      vat = createVatStorageMaterial({ offsets, normals, meta, params })
      lastPosTex = lastNrmTex = null
      preview = null
      syncPanelInputs()
      storageSummary = `storage ${verts} verts x ${params.frames} frames (.bin)`
      setStatus([storageSummary + storagePlaybackSuffix(), ...(uvWarn ? [`⚠ ${uvWarn}`] : [])])
    } else {
      if (!nextMesh.geometry.getAttribute('uv1') && !nextMesh.geometry.getAttribute('uv')) {
        throw new Error('Mesh has no UVs (vertex_anim expected as second UV set)')
      }
      const [positions, normals] = await Promise.all([
        loadTexture(sources.positions, { flipY: false }),
        loadTexture(sources.normals, { flipY: true }),
      ])
      const texW = positions.image.width
      const texH = positions.image.height
      params.texHeight = texH
      vat = createVatMaterial({ positionTexture: positions, normalTexture: normals, params })
      syncVatUniforms(vat.uniforms, params)
      syncPanelInputs()
      setStatus([`${params.wrapMode} ${texW}x${texH} | verts ${verts} | frames ${params.frames} x ${params.numWraps} wraps`])
      lastPosTex = positions
      lastNrmTex = normals
      refreshPreview()
    }
    nextMesh.material = vat.material
    vatMesh = nextMesh
    vatRoot = gltf.scene
    scene.add(vatRoot)

    if (frameCamera) frameMeshCamera()
    overlay.hidden = true
  } catch (error) {
    showError(`Could not load VAT assets: ${error.message}`)
    throw error
  }
}

function refreshPreview() {
  if (!lastPosTex || !lastNrmTex) return
  preview = buildPreview({
      posTexture: lastPosTex,
      normalTexture: lastNrmTex,
      frames: params.frames,
      numWraps: params.numWraps,
      posCanvas: document.querySelector('#preview-pos'),
      nrmCanvas: document.querySelector('#preview-nrm'),
      posDims: document.querySelector('#preview-pos-dims'),
      nrmDims: document.querySelector('#preview-nrm-dims'),
      statusEl: document.querySelector('#preview-status'),
    })
}

function applyExample(ex) {
  sources.mesh = ex.mesh
  sources.positions = ex.positions ?? ''
  sources.normals = ex.normals ?? ''
  sources.storage = ex.storage ?? ''
  sources.storageMeta = ex.storageMeta ?? ''
  params.backend = ex.storage ? 'storage' : 'texture'
  Object.assign(params, {
    frames: ex.frames,
    numWraps: ex.numWraps,
    wrapMode: 'wrap_crop',
    positionMode: ex.positionMode,
    normalize: ex.normalize,
    minOffset: ex.minOffset,
    maxOffset: ex.maxOffset,
    fps: ex.fps ?? params.fps,
    time: 0,
  })
  for (const [slot, url] of Object.entries(sources)) {
    document.querySelector(`[data-slot-label="${slot}"]`).textContent = url ? url.split('/').pop() : '—'
  }
}

async function bootExamples() {
  const res = await fetch('/examples.json')
  if (!res.ok) throw new Error('no examples manifest')
  EXAMPLES = (await res.json()).examples
  exampleSelect.innerHTML = ''
  for (const ex of EXAMPLES) {
    const opt = document.createElement('option')
    opt.value = ex.id
    opt.textContent = ex.label
    exampleSelect.appendChild(opt)
  }
  const wanted = new URLSearchParams(location.search).get('ex')
  const chosen = EXAMPLES.find((e) => e.id === wanted) ?? EXAMPLES[0]
  applyExample(chosen)
  exampleSelect.value = chosen.id
}

exampleSelect.addEventListener('change', () => {
  const ex = EXAMPLES.find((e) => e.id === exampleSelect.value)
  if (!ex) return
  applyExample(ex)
  reloadVat({ frameCamera: true }).catch(() => {})
})

function frameMeshCamera() {
  if (!vatMesh) return
  const bounds = new Box3().setFromObject(vatMesh)
  const center = bounds.getCenter(new Vector3())
  const size = bounds.getSize(new Vector3()).length()
  controls.target.copy(center)
  camera.position.copy(center).add(new Vector3(size, size * 0.7, size))
  camera.near = size / 100
  camera.far = size * 100
  camera.updateProjectionMatrix()
}

function tickPlayback(dt) {
  if (params.playing) params.time += dt * (params.reverse ? -1 : 1)
  const total = frameDuration()
  params.time = ((params.time % total) + total) % total
  if (vat) vat.uniforms.frame.value = params.time * params.fps
}

// --- Left panel bindings: every input writes params, syncs uniforms, refreshes ranges.
const panelInputs = [...document.querySelectorAll('[data-param]')]

function syncPanelInputs() {
  for (const input of panelInputs) {
    const key = input.dataset.param
    if (input.type === 'checkbox') input.checked = params[key]
    else if (input.tagName === 'SELECT') input.value = params[key]
    else input.value = params[key]
    if (key === 'time') input.max = frameDuration()
    // STEP/SMOOTH only drive the storage shader (textures already have
    // TEX_FILTER linear/nearest for the same hold-vs-lerp choice).
    if (key === 'step' || key === 'smooth') input.disabled = params.backend !== 'storage'
  }
}

for (const input of panelInputs) {
  input.addEventListener('input', () => {
    const key = input.dataset.param
    if (input.type === 'checkbox') params[key] = input.checked
    else if (input.type === 'number' || input.type === 'range') params[key] = Number(input.value)
    else params[key] = input.value
    if (key === 'step') params.step = Math.max(1, Math.round(params.step) || 1)
    if (key === 'frames' || key === 'fps') {
      const total = frameDuration()
      params.time = Math.min(params.time, total)
    }
    if (key === 'wrapMode' || key === 'frames') {
      // Mirror of the Blender bake tab: re-interprets the loaded textures.
      // NONE has a single block; WRAP_CROP derives exactly (Ht = F*K);
      // WRAP with padding rounds to the nearest block count (best effort).
      params.numWraps = params.wrapMode === 'none' ? 1 : Math.max(1, Math.round(params.texHeight / params.frames))
      refreshPreview()
    }
    if (params.backend === 'storage' && vat) {
      if (key === 'positionMode' || key === 'normalize' || key === 'minOffset' || key === 'maxOffset'
        || key === 'step' || key === 'smooth') {
        syncVatStorageUniforms(vat.uniforms, params)
      }
      if (key === 'step' || key === 'smooth') setStatus([storageSummary + storagePlaybackSuffix()])
    }
    if ((key === "texFilter" || key === "backend") && vat) {
      reloadVat({ frameCamera: false }).catch(() => {})
    }
    if (vat && params.backend !== 'storage') syncVatUniforms(vat.uniforms, params)
    syncPanelInputs()
  })
}

document.querySelector('#btn-frame-mesh').addEventListener('click', frameMeshCamera)
document.querySelector('#btn-reload').addEventListener('click', () => reloadVat({ frameCamera: false }))

// --- Responsive: off-canvas panel toggle (visible on <=768px via CSS) ---
const panel = document.querySelector('#panel')
document.querySelector('#panel-toggle').addEventListener('click', () => panel.classList.toggle('open'))
const texpreview = document.querySelector('#texpreview')
document.querySelector('#texpreview-toggle').addEventListener('click', () => texpreview.classList.toggle('open'))

// --- Drag & drop + file pickers ---
function setSource(slot, file) {
  if (sources[slot]?.startsWith('blob:')) URL.revokeObjectURL(sources[slot])
  sources[slot] = URL.createObjectURL(file)
  document.querySelector(`[data-slot-label="${slot}"]`).textContent = file.name
  reloadVat({ frameCamera: slot === 'mesh' }).catch(() => {})
}

for (const card of document.querySelectorAll('[data-slot]')) {
  const slot = card.dataset.slot
  const picker = card.querySelector('input[type="file"]')
  card.addEventListener('click', () => picker.click())
  picker.addEventListener('change', () => {
    if (picker.files[0]) setSource(slot, picker.files[0])
    picker.value = ''
  })
  for (const event of ['dragenter', 'dragover']) {
    card.addEventListener(event, (e) => {
      e.preventDefault()
      card.classList.add('drop-hint')
    })
  }
  for (const event of ['dragleave', 'drop']) {
    card.addEventListener(event, (e) => {
      e.preventDefault()
      card.classList.remove('drop-hint')
    })
  }
  card.addEventListener('drop', (event) => {
    if (event.dataTransfer.files[0]) setSource(slot, event.dataTransfer.files[0])
  })
}

// --- Main loop ---
syncPanelInputs()
const timer = new Timer()
renderer.setAnimationLoop(timestamp => {
  timer.update(timestamp)
  tickPlayback(timer.getDelta())
  const timeInput = panelInputs.find((input) => input.dataset.param === 'time')
  if (document.activeElement !== timeInput) timeInput.value = params.time
  const frameIndex = vat ? ((Math.floor(vat.uniforms.frame.value) % params.frames) + params.frames) % params.frames : 0
  frameReadout.textContent = vat ? String(frameIndex) : '–'
  if (preview && vat) preview.update(frameIndex)
  controls.update()
  renderer.render(scene, camera)
})

bootExamples()
  .catch(() => {})
  .finally(() => reloadVat({ frameCamera: true }).catch(() => {}))
  .finally(() => {
    // ?frame=N deep-links a paused frame (testing / sharing).
    const f = new URLSearchParams(location.search).get('frame')
    if (f !== null && vat) {
      params.time = Math.max(0, Number(f) || 0) / params.fps
      params.playing = false
      vat.uniforms.frame.value = params.time * params.fps
      syncPanelInputs()
    }
  })

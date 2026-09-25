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
import { buildPreview, buildStoragePreview } from './vat-preview.js'

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
const timeReadout = document.querySelector('#time-readout')
const btnPlay = document.querySelector('#btn-play')
const btnReverse = document.querySelector('#btn-reverse')
const icoPlay = btnPlay.querySelector('[data-icon="play"]')
const icoPause = btnPlay.querySelector('[data-icon="pause"]')
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
  return ` | step x${params.step}${params.smooth ? ' smooth' : ''} = ${parseFloat(effFps().toFixed(2))} fps`
}

function setStatus(lines) {
  statusBox.textContent = lines.join('\n')
}

// Human file weights in the asset slots (decimal MB, like the Blender panel).
function fmtSize(n) {
  n = Number(n)
  if (!Number.isFinite(n) || n < 0) return ''
  const units = ['B', 'KB', 'MB', 'GB']
  let u = 0
  while (n >= 1000 && u < units.length - 1) { n /= 1000; u++ }
  return u === 0 ? `${Math.round(n)} B` : `${n.toFixed(1)} ${units[u]}`
}

function setSlotLabel(slot, name, size) {
  document.querySelector(`[data-slot-label="${slot}"]`).textContent =
    size != null ? `${name} · ${fmtSize(size)}` : name
}

// Fill in remote (example) file weights via HEAD; blobs already carry
// their size from the drop handler. Silent fallback to bare names.
async function refreshSlotSizes() {
  for (const [slot, url] of Object.entries(sources)) {
    if (!url || url.startsWith('blob:')) continue
    const name = decodeURIComponent(url.split('/').pop())
    try {
      const head = await fetch(url, { method: 'HEAD' })
      const len = Number(head.headers.get('content-length'))
      setSlotLabel(slot, name, Number.isFinite(len) && len >= 0 ? len : null)
    } catch {
      setSlotLabel(slot, name, null)
    }
  }
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
  return params.frames / effFps()
}

// Effective playback rate: STEP is the export stride, so the viewer
// advances at base fps / step (same duration as a full-rate bake).
function effFps() {
  return params.fps / Math.max(1, params.step)
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
      vat.uniforms.posTexture?.value?.dispose?.()
      vat.uniforms.normalTexture?.value?.dispose?.()
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
        step: meta.frameStep ?? 1,
        numWraps: 1,
        positionMode: meta.positionMode ?? 'offsets',
        normalize: meta.normalize ?? false,
        minOffset: meta.minOffset ?? 0,
        maxOffset: meta.maxOffset ?? 1,
      })
      vat = createVatStorageMaterial({ offsets, normals, meta, params })
      lastPosTex = lastNrmTex = null
      preview = buildStoragePreview({
        offsets: offsets.array,
        normals: normals?.array ?? null,
        meta,
        posCanvas: document.querySelector('#preview-pos'),
        nrmCanvas: document.querySelector('#preview-nrm'),
        posDims: document.querySelector('#preview-pos-dims'),
        nrmDims: document.querySelector('#preview-nrm-dims'),
        statusEl: document.querySelector('#preview-status'),
      })
      syncPanelInputs()
      storageSummary = `storage ${verts} verts x ${params.frames} frames (.bin)${normals ? '' : ' | no normals (geometry)'}`
      setStatus([storageSummary + storagePlaybackSuffix(), ...(uvWarn ? [`⚠ ${uvWarn}`] : [])])
    } else {
      if (!nextMesh.geometry.getAttribute('uv1') && !nextMesh.geometry.getAttribute('uv')) {
        throw new Error('Mesh has no UVs (vertex_anim expected as second UV set)')
      }
      if (!sources.positions) throw new Error('Drop a positions texture below (slot 02)')
      const [positions, normals] = await Promise.all([
        loadTexture(sources.positions, { flipY: false }),
        sources.normals ? loadTexture(sources.normals, { flipY: true }) : null,
      ])
      const texW = positions.image.width
      const texH = positions.image.height
      params.texHeight = texH
      vat = createVatMaterial({ positionTexture: positions, normalTexture: normals, params })
      syncVatUniforms(vat.uniforms, params)
      syncPanelInputs()
      setStatus([`${params.wrapMode} ${texW}x${texH} | verts ${verts} | frames ${params.frames} x ${params.numWraps} wraps${normals ? '' : ' | no normals (geometry)'}`])
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
    refreshSlotSizes().catch(() => {})
  } catch (error) {
    showError(`Could not load VAT assets: ${error.message}`)
    throw error
  }
}

function refreshPreview() {
  if (!lastPosTex) return
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
    setSlotLabel(slot, url ? decodeURIComponent(url.split('/').pop()) : '—', null)
  }
}

async function bootExamples() {
  const res = await fetch('/examples.json')
  if (!res.ok) throw new Error('no examples manifest')
  EXAMPLES = (await res.json()).examples
  const wanted = new URLSearchParams(location.search).get('ex')
  const chosen = EXAMPLES.find((e) => e.id === wanted) ?? EXAMPLES[0]
  applyExample(chosen)
  filterExamples(chosen.id)
}

function hasDroppedSources() {
  return Object.values(sources).some((u) => u?.startsWith('blob:'))
}

// Show only the examples matching the current SOURCE backend. Auto-loads
// the first match when the current pick becomes incompatible — unless the
// user dropped custom files, which stay loaded (shown as CUSTOM DROP).
function filterExamples(preferId) {
  const cur = preferId ?? exampleSelect.value
  exampleSelect.innerHTML = ''
  const dropped = hasDroppedSources()
  if (dropped) {
    const opt = document.createElement('option')
    opt.value = '__drop'
    opt.textContent = 'CUSTOM DROP'
    exampleSelect.appendChild(opt)
  }
  const list = EXAMPLES.filter((e) => (e.storage ? 'storage' : 'texture') === params.backend)
  for (const ex of list) {
    const opt = document.createElement('option')
    opt.value = ex.id
    opt.textContent = ex.label
    exampleSelect.appendChild(opt)
  }
  if (list.some((e) => e.id === cur)) {
    exampleSelect.value = cur
    return
  }
  if (dropped || !list.length) {
    if (dropped) exampleSelect.value = '__drop'
    return
  }
  exampleSelect.value = list[0].id
  applyExample(list[0])
  reloadVat({ frameCamera: true }).catch(() => {})
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
  if (vat) vat.uniforms.frame.value = params.time * effFps()
}

// --- Left panel bindings: every input writes params, syncs uniforms, refreshes ranges.
const panelInputs = [...document.querySelectorAll('[data-param]')]

// (?) markers show a tooltip on hover: don't let them toggle their row's
// checkbox or focus its input when clicked.
for (const hint of document.querySelectorAll('.hint')) {
  for (const event of ['mousedown', 'click']) {
    hint.addEventListener(event, (e) => { e.preventDefault(); e.stopPropagation() })
  }
}

function syncPanelInputs() {
  for (const input of panelInputs) {
    const key = input.dataset.param
    if (input.type === 'checkbox') input.checked = params[key]
    else if (input.tagName === 'SELECT') input.value = params[key]
    else input.value = params[key]
    if (key === 'time') input.max = frameDuration()
    // Backend-scoped rows: storage hides texture-only bake params and
    // vice versa (textures already lerp via TEX_FILTER).
    const scoped = input.closest('[data-backends]')
    if (scoped) scoped.hidden = !scoped.dataset.backends.split(' ').includes(params.backend)
  }
  // Asset slots follow the same rule (storage: GLB+BIN+JSON,
  // texture: GLB+POSITIONS+NORMALS).
  for (const slot of document.querySelectorAll('[data-slot][data-backends]')) {
    slot.hidden = !slot.dataset.backends.split(' ').includes(params.backend)
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
      if (key === 'step' || key === 'smooth' || key === 'fps') setStatus([storageSummary + storagePlaybackSuffix()])
    }
    if ((key === "texFilter") && vat) {
      reloadVat({ frameCamera: false }).catch(() => {})
    }
    if (key === "backend" && vat) {
      // Refilter the example list (auto-loads a matching one); with
      // dropped files or no manifest, retry current sources instead.
      filterExamples()
      if (hasDroppedSources() || !EXAMPLES.length) reloadVat({ frameCamera: false }).catch(() => {})
    }
    if (vat && params.backend !== 'storage') syncVatUniforms(vat.uniforms, params)
    syncPanelInputs()
  })
}

document.querySelector('#btn-frame-mesh').addEventListener('click', frameMeshCamera)
document.querySelector('#btn-reload').addEventListener('click', () => reloadVat({ frameCamera: false }))

// --- Bottom timeline transport (Blender-like) ---
function stepFrame(dir) {
  const total = frameDuration()
  params.time = (((params.time + dir / effFps()) % total) + total) % total
  if (vat) vat.uniforms.frame.value = params.time * effFps()
}
btnPlay.addEventListener('click', () => { params.playing = !params.playing })
btnReverse.addEventListener('click', () => { params.reverse = !params.reverse })
document.querySelector('#btn-prev').addEventListener('click', () => stepFrame(-1))
document.querySelector('#btn-next').addEventListener('click', () => stepFrame(1))
addEventListener('keydown', (e) => {
  if (e.code === 'Space' && !/INPUT|SELECT|TEXTAREA|BUTTON/.test(document.activeElement?.tagName ?? '')) {
    e.preventDefault()
    params.playing = !params.playing
  }
})

// --- Resizable left panel (width persists across visits) ---
const panelResize = document.querySelector('#panel-resize')
try {
  const savedW = Number(localStorage.getItem('vat-panel-w'))
  if (savedW >= 220 && savedW <= 560) {
    document.documentElement.style.setProperty('--panel-w', `${savedW}px`)
  }
} catch { /* private mode: fixed width */ }
panelResize.addEventListener('pointerdown', (e) => {
  e.preventDefault()
  panelResize.classList.add('drag')
  panelResize.setPointerCapture(e.pointerId)
  const move = (ev) => {
    const w = Math.min(560, Math.max(220, ev.clientX))
    document.documentElement.style.setProperty('--panel-w', `${w}px`)
  }
  const up = () => {
    panelResize.classList.remove('drag')
    panelResize.removeEventListener('pointermove', move)
    panelResize.removeEventListener('pointerup', up)
    try {
      const w = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--panel-w'), 10)
      localStorage.setItem('vat-panel-w', String(w))
    } catch { /* ignore */ }
  }
  panelResize.addEventListener('pointermove', move)
  panelResize.addEventListener('pointerup', up)
})

// --- Responsive: off-canvas panel toggle (visible on <=768px via CSS) ---
const panel = document.querySelector('#panel')
document.querySelector('#panel-toggle').addEventListener('click', () => panel.classList.toggle('open'))
const texpreview = document.querySelector('#texpreview')
document.querySelector('#texpreview-toggle').addEventListener('click', () => texpreview.classList.toggle('open'))

// --- Resizable texture preview (width persists across visits) ---
const texResize = document.querySelector('#texpreview-resize')
try {
  const savedT = Number(localStorage.getItem('vat-texpw'))
  if (savedT >= 140 && savedT <= 520) {
    document.documentElement.style.setProperty('--texpw', `${savedT}px`)
  }
} catch { /* private mode: fixed width */ }
texResize.addEventListener('pointerdown', (e) => {
  e.preventDefault()
  texResize.classList.add('drag')
  texResize.setPointerCapture(e.pointerId)
  const startX = e.clientX
  const startW = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--texpw'), 10) || 200
  const move = (ev) => {
    const w = Math.min(520, Math.max(140, startW + (startX - ev.clientX)))
    document.documentElement.style.setProperty('--texpw', `${w}px`)
  }
  const up = () => {
    texResize.classList.remove('drag')
    texResize.removeEventListener('pointermove', move)
    texResize.removeEventListener('pointerup', up)
    try {
      const w = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--texpw'), 10)
      localStorage.setItem('vat-texpw', String(w))
    } catch { /* ignore */ }
  }
  texResize.addEventListener('pointermove', move)
  texResize.addEventListener('pointerup', up)
})

// --- Drag & drop + file pickers ---
function setSource(slot, file) {
  if (sources[slot]?.startsWith('blob:')) URL.revokeObjectURL(sources[slot])
  sources[slot] = URL.createObjectURL(file)
  setSlotLabel(slot, file.name, file.size)
  // Dropped slot dictates the backend (a .bin without storage mode fails).
  if (slot === 'storage' || slot === 'storageMeta') params.backend = 'storage'
  if (slot === 'positions' || slot === 'normals') params.backend = 'texture'
  syncPanelInputs()
  filterExamples('__drop')
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

// --- Per-slot clear (×): empties the slot and reloads with the rest.
// Clearing normals falls back to geometry normals; clearing anything
// else errors loudly until a file is dropped again.
for (const btn of document.querySelectorAll('[data-clear]')) {
  for (const event of ['mousedown', 'click']) {
    btn.addEventListener(event, (e) => e.stopPropagation())
  }
  btn.addEventListener('click', (e) => {
    e.preventDefault()
    const slot = btn.dataset.clear
    if (sources[slot]?.startsWith('blob:')) URL.revokeObjectURL(sources[slot])
    sources[slot] = ''
    setSlotLabel(slot, '—', null)
    reloadVat({ frameCamera: false }).catch(() => {})
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
  frameReadout.textContent = vat
    ? `${String(frameIndex).padStart(String(params.frames).length, '0')} / ${params.frames}`
    : '–'
  timeReadout.textContent = vat ? `${params.time.toFixed(2)}s / ${frameDuration().toFixed(2)}s` : '–'
  icoPlay.hidden = params.playing
  icoPause.hidden = !params.playing
  btnReverse.classList.toggle('on', params.reverse)
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
      params.time = Math.max(0, Number(f) || 0) / effFps()
      params.playing = false
      vat.uniforms.frame.value = params.time * effFps()
      syncPanelInputs()
    }
  })

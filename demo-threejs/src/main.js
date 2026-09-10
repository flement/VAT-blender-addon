import {
  ACESFilmicToneMapping,
  Box3,
  DataTexture,
  DirectionalLight,
  GridHelper,
  HemisphereLight,
  LinearFilter, NearestFilter,
  NoColorSpace,
  PerspectiveCamera,
  PMREMGenerator,
  RepeatWrapping,
  RGBAFormat,
  Scene,
  TextureLoader,
  Timer,
  UnsignedByteType,
  Vector3,
  WebGLRenderer,
} from 'three'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { EXRLoader } from 'three/addons/loaders/EXRLoader.js'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { createVatMaterial, syncVatUniforms } from './vat-material.js'

const DEFAULT_SOURCES = {
  mesh: '/vat_test.glb',
  positions: '/positions.exr',
  normals: '/normals.png',
}

// Live-tweakable bake parameters (wrap NONE only).
const params = {
  frames: 30,
  positionMode: 'offsets',
  flipY: true,
  normalize: false,
  minOffset: 0,
  maxOffset: 1,
  fps: 24,
  playing: true,
  reverse: false,
  time: 0,
}

const sources = { ...DEFAULT_SOURCES }
const container = document.querySelector('#app')
const overlay = document.querySelector('#overlay')
const overlayText = document.querySelector('#overlay-text')
const statusBox = document.querySelector('#status')
const frameReadout = document.querySelector('#frame-readout')

const renderer = new WebGLRenderer({ antialias: true })
renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
renderer.setSize(container.clientWidth, container.clientHeight)
container.appendChild(renderer.domElement)

const scene = new Scene()
scene.add(new GridHelper(10, 20))

const sun = new DirectionalLight(0xffffff, 2.5)
sun.position.set(4, 6, 3)
scene.add(sun)
scene.add(new HemisphereLight(0xbfd4ff, 0x30281e, 0.6))
const pmrem = new PMREMGenerator(renderer)
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture
pmrem.dispose()
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

function setStatus(lines) {
  statusBox.textContent = lines.join('\n')
}

function showError(message) {
  overlay.hidden = false
  overlayText.textContent = message
  overlayText.classList.add('error')
}

function prepareTexture(texture) {
  texture.flipY = params.flipY
  texture.colorSpace = NoColorSpace
  texture.minFilter = texture.magFilter = NearestFilter
  texture.needsUpdate = true
  return texture
}

async function loadTexture(url) {
  const loader = url.toLowerCase().endsWith('.exr') ? new EXRLoader() : new TextureLoader()
  return prepareTexture(await loader.loadAsync(url))
}

function frameDuration() {
  return params.frames / params.fps
}

async function reloadVat({ frameCamera }) {
  overlay.hidden = false
  overlayText.classList.remove('error')
  overlayText.textContent = 'Loading VAT assets…'
  try {
    const [gltf, positions, normals] = await Promise.all([
      new GLTFLoader().loadAsync(sources.mesh),
      loadTexture(sources.positions),
      loadTexture(sources.normals),
    ])

    const nextMesh = gltf.scene.children.find((child) => child.isMesh)
    if (!nextMesh) throw new Error('No mesh found in the GLB')
    if (!nextMesh.geometry.getAttribute('uv1') && !nextMesh.geometry.getAttribute('uv')) {
      throw new Error('Mesh has no UVs (vertex_anim expected as second UV set)')
    }

    if (vatRoot) scene.remove(vatRoot)
    if (vat) {
      vat.uniforms.posTexture.value.dispose()
      vat.uniforms.normalTexture.value.dispose()
      vat.material.dispose()
    }
    vat = createVatMaterial({ positionTexture: positions, normalTexture: normals, params })
    nextMesh.material = vat.material
    vatMesh = nextMesh
    vatRoot = gltf.scene
    scene.add(vatRoot)

    // Wrap NONE: texture height = frame count.
    const texW = positions.image.width
    const texH = positions.image.height
    const verts = nextMesh.geometry.getAttribute('position').count
    params.frames = texH
    params.time = 0
    syncVatUniforms(vat.uniforms, params)
    syncPanelInputs()
    setStatus([`positions ${texW}x${texH} | verts ${verts} | frames ${texH}`])

    if (frameCamera) frameMeshCamera()
    overlay.hidden = true
  } catch (error) {
    showError(`Could not load VAT assets: ${error.message}`)
    throw error
  }
}

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
    else input.value = params[key]
    if (key === 'time') input.max = frameDuration()
  }
}

for (const input of panelInputs) {
  input.addEventListener('input', () => {
    const key = input.dataset.param
    if (input.type === 'checkbox') params[key] = input.checked
    else if (input.type === 'number' || input.type === 'range') params[key] = Number(input.value)
    else params[key] = input.value
    if (key === 'frames' || key === 'fps') {
      const total = frameDuration()
      params.time = Math.min(params.time, total)
    }
    if (vat) syncVatUniforms(vat.uniforms, params)
    syncPanelInputs()
  })
}

document.querySelector('#btn-frame-mesh').addEventListener('click', frameMeshCamera)
document.querySelector('#btn-reload').addEventListener('click', () => reloadVat({ frameCamera: false }))

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
  frameReadout.textContent = vat ? String(Math.floor(vat.uniforms.frame.value) % params.frames) : '–'
  controls.update()
  renderer.render(scene, camera)
})

reloadVat({ frameCamera: true }).catch(() => {})

export {}

type Signal =
  | { type: 'hello' | 'ready'; from: string; to?: string }
  | { type: 'offer' | 'answer'; from: string; to: string; sdp: RTCSessionDescriptionInit }
  | { type: 'ice'; from: string; to: string; candidate: RTCIceCandidateInit }

const local = document.querySelector<HTMLVideoElement>('#local')!
const remote = document.querySelector<HTMLVideoElement>('#remote')!
const join = document.querySelector<HTMLButtonElement>('#join')!
const leave = document.querySelector<HTMLButtonElement>('#leave')!
const mic = document.querySelector<HTMLButtonElement>('#mic')!
const camera = document.querySelector<HTMLButtonElement>('#camera')!
const play = document.querySelector<HTMLButtonElement>('#play')!
const status = document.querySelector<HTMLElement>('#status')!
const hint = document.querySelector<HTMLElement>('#hint')!
const placeholder = document.querySelector<HTMLElement>('#placeholder')!

let stream: MediaStream | null = null
let socket: WebSocket | null = null
let peer: RTCPeerConnection | null = null
let myId = ''
let peerId = ''
let pendingIce: RTCIceCandidateInit[] = []
let sessionNumber = 0
let connectingTimer: number | undefined

function send(message: Signal) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message))
}

function closePeer() {
  const old = peer
  peer = null
  old?.close()
  peerId = ''
  pendingIce = []
  remote.srcObject = null
  remote.classList.remove('active')
  play.hidden = true
}

function stop(message: string) {
  sessionNumber++
  clearTimeout(connectingTimer)
  closePeer()
  const old = socket
  socket = null
  old?.close()
  stream?.getTracks().forEach(track => track.stop())
  stream = null
  local.srcObject = null
  local.classList.remove('active')
  join.hidden = false
  leave.hidden = true
  updateDevices()
  status.textContent = 'До звонка'
  placeholder.textContent = 'Здесь появится собеседник'
  hint.textContent = message
}

function updateDevices() {
  const audioOn = stream?.getAudioTracks()[0]?.enabled
  const videoOn = stream?.getVideoTracks()[0]?.enabled
  mic.disabled = camera.disabled = !stream
  mic.textContent = audioOn === false ? 'Включить микрофон' : 'Выключить микрофон'
  camera.textContent = videoOn === false ? 'Включить камеру' : 'Выключить камеру'
  mic.setAttribute('aria-pressed', String(audioOn === false))
  camera.setAttribute('aria-pressed', String(videoOn === false))
  local.classList.toggle('active', Boolean(videoOn))
}

function waiting() {
  status.textContent = 'Ожидание собеседника'
  placeholder.textContent = 'Ждём второго участника'
  hint.textContent = 'Оставьте страницу открытой. Звонок начнётся, когда подключится собеседник.'
}

function connectPeer(id: string) {
  const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] })
  peer = pc
  peerId = id
  status.textContent = 'Соединяем…'
  for (const track of stream!.getTracks()) pc.addTrack(track, stream!)
  pc.onicecandidate = event => {
    if (pc === peer && event.candidate) {
      send({ type: 'ice', from: myId, to: id, candidate: event.candidate.toJSON() })
    }
  }
  pc.ontrack = event => {
    if (pc !== peer) return
    remote.srcObject = event.streams[0]
    remote.classList.add('active')
    remote.play().catch(() => { if (pc === peer) play.hidden = false })
  }
  pc.onconnectionstatechange = () => {
    if (pc !== peer) return
    if (pc.connectionState === 'connected') {
      status.textContent = 'В эфире'
      hint.textContent = 'Вы на связи. Камерой и микрофоном можно управлять во время разговора.'
    }
    if (pc.connectionState === 'disconnected') status.textContent = 'Связь прерывается…'
    if (pc.connectionState === 'failed') stop('Не удалось соединить устройства. Попробуйте снова или смените сеть.')
  }
  return pc
}

async function handleMessage(raw: string) {
  let msg
  try { msg = JSON.parse(raw) } catch { return }
  if (!msg) return
  if (msg.type === 'peer-left') {
    closePeer()
    waiting()
    hint.textContent = 'Собеседник вышел. Можно дождаться следующего участника.'
    return
  }
  if (typeof msg.from !== 'string' || msg.from === myId || (msg.to && msg.to !== myId)) return
  if (msg.type === 'hello' || msg.type === 'ready') {
    if (peer && peerId !== msg.from) closePeer()
    if (msg.type === 'hello') send({ type: 'ready', from: myId, to: msg.from })
    if (peer) return
    const pc = connectPeer(msg.from)
    // Даже при одновременном входе только один участник создаёт offer.
    if (myId < msg.from) {
      await pc.setLocalDescription(await pc.createOffer())
      if (peerId === msg.from && socket?.readyState === WebSocket.OPEN) send({ type: 'offer', from: myId, to: msg.from, sdp: pc.localDescription! })
    }
    return
  }
  const pc = peer
  if (!pc || msg.from !== peerId || msg.to !== myId) return
  if (msg.type === 'ice' && msg.candidate) {
    if (pc.remoteDescription) await pc.addIceCandidate(msg.candidate)
    else pendingIce.push(msg.candidate)
  }
  if (msg.type === 'offer' || msg.type === 'answer') {
    await pc.setRemoteDescription(msg.sdp)
    if (pc !== peer) return
    for (const candidate of pendingIce.splice(0)) await pc.addIceCandidate(candidate)
    if (msg.type === 'offer') {
      await pc.setLocalDescription(await pc.createAnswer())
      if (pc === peer) send({ type: 'answer', from: myId, to: msg.from, sdp: pc.localDescription! })
    }
  }
}

async function start() {
  const session = ++sessionNumber
  join.hidden = true
  leave.hidden = false
  status.textContent = 'Подключение…'
  hint.textContent = 'Разрешите браузеру использовать камеру и микрофон.'
  try {
    const media = await navigator.mediaDevices.getUserMedia({ video: true, audio: true })
    if (session !== sessionNumber) {
      media.getTracks().forEach(track => track.stop())
      return
    }
    stream = media
    local.srcObject = media
    updateDevices()
    myId = crypto.randomUUID()
    const ws = new WebSocket('wss://inai-col3.fishrungames.com/signaling/')
    socket = ws
    connectingTimer = window.setTimeout(() => {
      if (socket === ws) stop('Сервер не ответил. Попробуйте войти ещё раз.')
    }, 15000)
    ws.onopen = () => {
      if (socket !== ws) return
      clearTimeout(connectingTimer)
      waiting()
      send({ type: 'hello', from: myId })
    }
    // Обрабатываем SDP и ICE в порядке получения сообщений.
    let queue = Promise.resolve()
    ws.onmessage = event => {
      queue = queue.then(async () => {
        if (socket === ws) await handleMessage(event.data)
      }).catch(() => {
        if (socket === ws) stop('Ошибка согласования звонка. Войдите в комнату снова.')
      })
    }
    ws.onclose = () => {
      if (socket === ws) stop('Сервер закрыл соединение. В комнате могут находиться только двое. Можно войти снова.')
    }
    ws.onerror = () => {
      if (socket === ws) stop('Сервер связи недоступен. Попробуйте повторить подключение.')
    }
  } catch (error) {
    if (session !== sessionNumber) return
    const name = error instanceof Error ? error.name : ''
    stop(name === 'NotAllowedError' ? 'Разрешите доступ к камере и микрофону в настройках браузера и войдите снова.'
      : 'Не удалось начать звонок. Проверьте камеру, микрофон и адрес страницы (HTTPS или localhost).')
  }
}

join.onclick = start
leave.onclick = () => stop('Звонок завершён. Вы можете войти снова.')
mic.onclick = () => {
  const track = stream?.getAudioTracks()[0]
  if (track) track.enabled = !track.enabled
  updateDevices()
}
camera.onclick = () => {
  const track = stream?.getVideoTracks()[0]
  if (track) track.enabled = !track.enabled
  updateDevices()
}
play.onclick = async () => {
  try { await remote.play(); play.hidden = true }
  catch { hint.textContent = 'Проверьте разрешение браузера на воспроизведение звука.' }
}
window.addEventListener('pagehide', () => stop('Вы вышли из комнаты.'))

import * as THREE from 'three';
import { XRHandModelFactory } from 'three/addons/webxr/XRHandModelFactory.js';
import { advanceDrink, createDrink, isDrinkingTilt, isNearMouth } from './sip.js';
import { createCompanion } from './companion.js';
import './style.css';

const $ = (selector) => document.querySelector(selector);
const enterButton = $('#enter-xr');
const status = $('#status');
const errorBox = $('#error');
const viewport = $('#viewport');
let renderer;

function showError(message, error) {
  console.error(message, error);
  errorBox.hidden = false;
  errorBox.textContent = `${message}${error?.message ? ` ${error.message}` : ''}`;
}

try {
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
} catch (error) {
  showError('WebGL could not start. Enable hardware acceleration or use the Quest browser.', error);
  enterButton.textContent = 'Graphics unavailable';
}

if (renderer) {
  initialize().catch((error) => showError('The app could not start.', error));
}

async function initialize() {
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setClearColor(0x000000, 0);
  renderer.xr.enabled = true;
  renderer.xr.setReferenceSpaceType('local-floor');
  viewport.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 30);
  camera.position.set(0.5, 1.5, 1);
  camera.lookAt(0, 0.99, -0.5);
  scene.add(camera);
  scene.add(new THREE.HemisphereLight(0xdbf8ff, 0x54645d, 2.7));
  const light = new THREE.DirectionalLight(0xffffff, 3);
  light.position.set(1, 3, 2);
  scene.add(light);

  const tabletop = new THREE.Mesh(
    new THREE.CylinderGeometry(0.55, 0.55, 0.025, 64),
    new THREE.MeshStandardMaterial({ color: 0x35535b, roughness: 0.8 }),
  );
  tabletop.position.set(0, 0.8, -0.5);
  scene.add(tabletop);
  const grid = new THREE.GridHelper(4, 40, 0x4c7985, 0x2d4754);
  grid.position.y = 0.05;
  scene.add(grid);

  // The cup origin is its base, so placement refers to the supporting surface.
  const cup = new THREE.Group();
  const glassMaterial = new THREE.MeshPhysicalMaterial({
    color: 0xd3f9ff, transparent: true, opacity: 0.27,
    roughness: 0.13, metalness: 0.05, side: THREE.DoubleSide, depthWrite: false,
  });
  const shell = new THREE.Mesh(new THREE.CylinderGeometry(0.047, 0.036, 0.13, 48, 1, true), glassMaterial);
  shell.position.y = 0.065;
  cup.add(shell);
  const rim = new THREE.Mesh(
    new THREE.TorusGeometry(0.047, 0.002, 8, 64),
    new THREE.MeshStandardMaterial({ color: 0xd6faff, metalness: 0.35, roughness: 0.2 }),
  );
  rim.rotation.x = Math.PI / 2;
  rim.position.y = 0.13;
  cup.add(rim);
  const base = new THREE.Mesh(new THREE.CylinderGeometry(0.036, 0.036, 0.004, 48), glassMaterial);
  base.position.y = 0.002;
  cup.add(base);
  const liquid = new THREE.Mesh(
    new THREE.CylinderGeometry(0.041, 0.033, 0.105, 48),
    new THREE.MeshStandardMaterial({ color: 0xffb94f, roughness: 0.22, metalness: 0.05 }),
  );
  cup.add(liquid);
  const liquidTop = new THREE.Mesh(
    new THREE.CircleGeometry(0.041, 48),
    new THREE.MeshStandardMaterial({ color: 0xffd681, side: THREE.DoubleSide, roughness: 0.3 }),
  );
  liquidTop.rotation.x = -Math.PI / 2;
  cup.add(liquidTop);
  cup.position.set(0, 0.815, -0.5);
  scene.add(cup);

  const halo = new THREE.Mesh(
    new THREE.RingGeometry(0.065, 0.072, 48),
    new THREE.MeshBasicMaterial({ color: 0x9df6cf, side: THREE.DoubleSide, transparent: true, opacity: 0.8 }),
  );
  halo.rotation.x = -Math.PI / 2;
  scene.add(halo);
  const marker = new THREE.Mesh(
    new THREE.RingGeometry(0.035, 0.045, 40),
    new THREE.MeshBasicMaterial({ color: 0xb6f4cf, side: THREE.DoubleSide }),
  );
  marker.rotation.x = -Math.PI / 2;
  marker.visible = false;
  scene.add(marker);

  const panelCanvas = document.createElement('canvas');
  panelCanvas.width = 1024;
  panelCanvas.height = 256;
  const panelContext = panelCanvas.getContext('2d');
  if (!panelContext) throw new Error('The headset instruction panel needs a 2D canvas.');
  const panelTexture = new THREE.CanvasTexture(panelCanvas);
  panelTexture.colorSpace = THREE.SRGBColorSpace;
  const panel = new THREE.Mesh(
    new THREE.PlaneGeometry(0.7, 0.175),
    new THREE.MeshBasicMaterial({ map: panelTexture, transparent: true, side: THREE.DoubleSide }),
  );
  panel.visible = false;
  scene.add(panel);

  let drink = createDrink();
  let placed = false;
  let heldBy = null;
  let desktopDemo = false;
  let demoSipping = false;
  let lastTime;
  let lastPanelText = '';
  let lastPercent = -1;
  let positionPanel = false;
  let carryOffset = null;
  const controllers = [];
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  const rotationMatrix = new THREE.Matrix4();
  const worldPosition = new THREE.Vector3();
  const rimPosition = new THREE.Vector3();
  const mouthPosition = new THREE.Vector3();
  const headQuaternion = new THREE.Quaternion();
  const cupQuaternion = new THREE.Quaternion();
  const up = new THREE.Vector3();
  const handFactory = new XRHandModelFactory();
  const carryMatrix = new THREE.Matrix4();
  const localCupMatrix = new THREE.Matrix4();
  const glassHome = cup.position.clone();
  let companionHolding = false;
  let glassMotion = null;
  const companion = createCompanion({
    scene,
    getContext: () => ({
      glassAvailable: placed && cup.visible,
      glassHeldByUser: heldBy !== null,
      glassHeldByCompanion: companionHolding,
    }),
    onAction(action) {
      if (action === 'none') return;
      if (!['pick_up_glass', 'throw_glass', 'put_down_glass'].includes(action)) {
        throw new Error('Pip requested an unsupported action.');
      }
      if (!placed || !cup.visible) throw new Error('Place the virtual glass before asking Pip to move it.');
      if (heldBy) throw new Error('Release the virtual cup before asking Pip to move it.');
      if (glassMotion) throw new Error('Pip is already moving the cup. Wait for the action to finish.');
      if (action === 'put_down_glass') {
        glassMotion = { phase: 'put-down', elapsed: 0, start: cup.position.clone() };
      } else {
        glassMotion = {
          phase: companionHolding ? 'carry' : 'approach', elapsed: 0,
          throwAfter: action === 'throw_glass',
          start: companion.root.position.clone(),
          destination: cup.position.clone().add(new THREE.Vector3(-0.1, 0.18, 0)),
        };
      }
    },
  });

  function updatePanel(text) {
    if (text === lastPanelText) return;
    lastPanelText = text;
    panelContext.clearRect(0, 0, 1024, 256);
    panelContext.fillStyle = 'rgba(12, 27, 38, 0.94)';
    panelContext.beginPath();
    panelContext.roundRect(0, 0, 1024, 256, 28);
    panelContext.fill();
    panelContext.textAlign = 'center';
    panelContext.fillStyle = '#b6f4cf';
    panelContext.font = 'bold 28px sans-serif';
    panelContext.fillText('GLASS LAB  /  VIRTUAL CUP ONLY', 512, 51);
    panelContext.fillStyle = '#ffffff';
    panelContext.font = '32px sans-serif';
    text.split('\n').forEach((line, index) => panelContext.fillText(line, 512, 111 + index * 45));
    panelTexture.needsUpdate = true;
  }

  function reset() {
    if (heldBy) release(heldBy);
    drink = createDrink();
    companionHolding = false;
    glassMotion = null;
    placed = false;
    demoSipping = false;
    cup.quaternion.identity();
    cup.position.set(0, 0.815, -0.5);
    cup.visible = !renderer.xr.isPresenting;
    marker.visible = false;
    status.textContent = renderer.xr.isPresenting
      ? 'Aim at the glass and pinch or press the trigger to mark it.'
      : 'Reset. Enter mixed reality, or try the desktop demo.';
  }

  function setRay(controller) {
    controller.updateWorldMatrix(true, false);
    rotationMatrix.extractRotation(controller.matrixWorld);
    raycaster.ray.origin.setFromMatrixPosition(controller.matrixWorld);
    raycaster.ray.direction.set(0, 0, -1).applyMatrix4(rotationMatrix).normalize();
  }

  function placementPoint(controller) {
    setRay(controller);
    // Manual depth: place 35 cm along the pointing ray, not on a detected plane.
    return raycaster.ray.at(0.35, new THREE.Vector3());
  }

  function grab(controller) {
    if (companionHolding || glassMotion) {
      status.textContent = 'Pip is moving the cup. Ask Pip to put it down before grabbing it.';
      return;
    }
    if (heldBy || !cup.visible || drink.fill === 0) return;
    controller.attach(cup);
    heldBy = controller;
    carryOffset = null;
    status.textContent = 'Holding virtual cup. Bring it near your mouth and tilt to sip.';
  }

  function release(controller) {
    if (heldBy !== controller) return;
    scene.attach(cup);
    heldBy = null;
    carryOffset = null;
    // Keep an upright cup where released; this prototype has no gravity.
    cup.quaternion.identity();
    demoSipping = false;
  }

  function selectStart(controller) {
    if (!controller.userData.tracked) return;
    setRay(controller);
    if (companion.select(raycaster)) return;
    if (drink.fill === 0) {
      reset();
      return;
    }
    if (!placed) {
      cup.position.copy(placementPoint(controller));
      glassHome.copy(cup.position);
      cup.quaternion.identity();
      cup.visible = true;
      placed = true;
      status.textContent = 'Cup placed. Release, then aim at the virtual cup and hold a pinch or trigger to grab.';
      return;
    }
    setRay(controller);
    if (raycaster.intersectObject(cup, true).length) grab(controller);
  }

  for (let index = 0; index < 2; index++) {
    const controller = renderer.xr.getController(index);
    controller.userData.tracked = false;
    controller.addEventListener('connected', (event) => {
      controller.userData.tracked = true;
      controller.userData.inputSource = event.data;
    });
    controller.addEventListener('disconnected', () => {
      controller.userData.tracked = false;
      delete controller.userData.inputSource;
      release(controller);
    });
    controller.addEventListener('selectstart', () => selectStart(controller));
    controller.addEventListener('selectend', () => release(controller));
    controller.addEventListener('squeezestart', () => {
      if (controller.userData.inputSource?.handedness === 'left') reset();
    });
    const line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 0, -1)]),
      new THREE.LineBasicMaterial({ color: 0xb6f4cf, transparent: true, opacity: 0.6 }),
    );
    line.scale.z = 0.35;
    controller.add(line);
    scene.add(controller);
    controllers.push(controller);
    const grip = renderer.xr.getControllerGrip(index);
    const handle = new THREE.Mesh(
      new THREE.CylinderGeometry(0.015, 0.019, 0.09, 12),
      new THREE.MeshStandardMaterial({ color: 0x73998f, roughness: 0.5 }),
    );
    handle.rotation.x = Math.PI / 3;
    grip.add(handle);
    scene.add(grip);
    const hand = renderer.xr.getHand(index);
    hand.add(handFactory.createHandModel(hand, 'boxes'));
    scene.add(hand);
  }

  function resize() {
    const { width, height } = viewport.getBoundingClientRect();
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    if (!renderer.xr.isPresenting) renderer.setSize(width, height);
  }
  new ResizeObserver(resize).observe(viewport);
  resize();

  renderer.xr.addEventListener('sessionstart', () => {
    companion.enterXR();
    tabletop.visible = false;
    grid.visible = false;
    panel.visible = true;
    positionPanel = true;
    reset();
    enterButton.textContent = 'Exit mixed reality';
    $('#preview-toggle').disabled = true;
  });

  renderer.xr.addEventListener('sessionend', () => {
    companion.leaveXR();
    if (heldBy) release(heldBy);
    tabletop.visible = true;
    grid.visible = true;
    panel.visible = false;
    marker.visible = false;
    enterButton.textContent = 'Enter mixed reality';
    $('#preview-toggle').disabled = false;
    reset();
    camera.position.set(0.5, 1.5, 1);
    camera.lookAt(0, 0.99, -0.5);
    status.textContent = 'Session ended. Real-world placement is not saved between sessions.';
    resize();
  });

  enterButton.addEventListener('click', async () => {
    errorBox.hidden = true;
    enterButton.disabled = true;
    let session;
    try {
      const current = renderer.xr.getSession();
      if (current) {
        await current.end();
      } else {
        session = await navigator.xr.requestSession('immersive-ar', {
          requiredFeatures: ['local-floor'],
          optionalFeatures: ['hand-tracking'],
        });
        await renderer.xr.setSession(session);
      }
    } catch (error) {
      if (session) {
        try {
          await session.end();
        } catch (cleanupError) {
          showError('The incomplete XR session could not be closed.', cleanupError);
        }
      }
      showError('Mixed reality could not start. Use Meta Quest Browser and allow immersive access.', error);
    } finally {
      enterButton.disabled = false;
    }
  });

  $('#preview-toggle').addEventListener('click', () => {
    desktopDemo = !desktopDemo;
    $('#preview-toggle').textContent = desktopDemo ? 'Leave desktop demo' : 'Try desktop demo';
    $('#demo-help').hidden = !desktopDemo;
    reset();
    if (desktopDemo) {
      cup.visible = false;
      status.textContent = 'Desktop demo: click the table to place your virtual cup.';
    }
  });
  $('#refill').addEventListener('click', reset);

  renderer.domElement.addEventListener('pointerdown', (event) => {
    if (!desktopDemo || renderer.xr.isPresenting) return;
    if (drink.fill === 0) {
      reset();
      return;
    }
    if (heldBy) {
      release(camera);
      return;
    }
    const bounds = renderer.domElement.getBoundingClientRect();
    pointer.set(
      ((event.clientX - bounds.left) / bounds.width) * 2 - 1,
      -((event.clientY - bounds.top) / bounds.height) * 2 + 1,
    );
    raycaster.setFromCamera(pointer, camera);
    if (placed && raycaster.intersectObject(cup, true).length) {
      grab(camera);
      return;
    }
    const hit = raycaster.intersectObject(tabletop)[0];
    if (hit) {
      cup.position.copy(hit.point);
      glassHome.copy(cup.position);
      cup.quaternion.identity();
      cup.visible = true;
      placed = true;
      status.textContent = 'Click the cup to grab it, then hold S to simulate a sip.';
    }
  });
  window.addEventListener('keydown', (event) => {
    if (event.code === 'KeyS' && desktopDemo && heldBy === camera) demoSipping = true;
    if (event.code === 'KeyR' && !renderer.xr.isPresenting) reset();
  });
  window.addEventListener('keyup', (event) => {
    if (event.code === 'KeyS') demoSipping = false;
  });
  window.addEventListener('blur', () => { demoSipping = false; });

  renderer.setAnimationLoop((time, frame) => {
    const deltaSeconds = lastTime === undefined ? 0 : (time - lastTime) / 1000;
    lastTime = time;
    const inXR = renderer.xr.isPresenting;
    const viewerPose = inXR && frame?.getViewerPose(renderer.xr.getReferenceSpace());
    if (viewerPose) {
      worldPosition.copy(viewerPose.transform.position);
      headQuaternion.copy(viewerPose.transform.orientation);
      if (positionPanel) {
        panel.position.set(0, 0.12, -1.1).applyQuaternion(headQuaternion).add(worldPosition);
        panel.quaternion.copy(headQuaternion);
        positionPanel = false;
      }
    } else {
      camera.getWorldPosition(worldPosition);
      camera.getWorldQuaternion(headQuaternion);
    }
    mouthPosition.set(0, -0.09, -0.08).applyQuaternion(headQuaternion).add(worldPosition);
    companion.update(time, worldPosition, headQuaternion, Boolean(viewerPose));
    if (glassMotion) {
      glassMotion.elapsed += Math.min(deltaSeconds, 0.1);
      if (glassMotion.phase === 'approach') {
        companion.root.position.lerpVectors(glassMotion.start, glassMotion.destination, Math.min(1, glassMotion.elapsed / 0.6));
        if (glassMotion.elapsed >= 0.6) {
          companionHolding = true;
          glassMotion.phase = 'carry';
          glassMotion.elapsed = 0;
        }
      } else if (glassMotion.phase === 'carry') {
        companionHolding = true;
        if (!glassMotion.throwAfter) {
          glassMotion = null;
          status.textContent = 'Pip is holding the virtual cup.';
        } else if (glassMotion.elapsed > 0.4) {
          const away = cup.position.clone().sub(worldPosition).setY(0);
          if (away.lengthSq() < 0.001) away.set(0, 0, -1);
          const velocity = away.normalize().multiplyScalar(1.7).setY(1.7);
          glassMotion = { phase: 'flight', elapsed: 0, start: cup.position.clone(), velocity };
          companionHolding = false;
        }
      } else if (glassMotion.phase === 'put-down') {
        companionHolding = false;
        cup.position.lerpVectors(glassMotion.start, glassHome, Math.min(1, glassMotion.elapsed / 0.6));
        if (glassMotion.elapsed >= 0.6) {
          glassMotion = null;
          status.textContent = 'Pip put the virtual cup back.';
        }
      } else if (glassMotion.phase === 'flight') {
        const t = glassMotion.elapsed;
        cup.position.copy(glassMotion.start).addScaledVector(glassMotion.velocity, t);
        cup.position.y -= 4.9 * t * t;
        cup.rotation.x += deltaSeconds * 3;
        if (t > 1.2) {
          glassMotion = null;
          cup.visible = false;
          placed = false;
          cup.quaternion.identity();
          status.textContent = 'Virtual cup thrown. Mark a glass again or reset. The real glass did not move.';
        }
      }
    }
    if (companionHolding) cup.position.copy(companion.root.position).add(new THREE.Vector3(0.1, -0.13, 0));

    // A target-ray space aims at objects. A grip or wrist pose carries the cup.
    if (heldBy && inXR && frame) {
      const assignedSource = heldBy.userData.inputSource;
      const wristSpace = assignedSource?.hand?.get('wrist');
      const carrySpace = wristSpace ?? assignedSource?.gripSpace;
      const pose = carrySpace && frame.getPose(carrySpace, renderer.xr.getReferenceSpace());
      if (pose) {
        carryMatrix.fromArray(pose.transform.matrix);
        if (!carryOffset) {
          // Start upright at the hand, then preserve wrist rotation relative to pickup.
          const pickupMatrix = new THREE.Matrix4().makeTranslation(
            pose.transform.position.x,
            pose.transform.position.y - 0.05,
            pose.transform.position.z,
          );
          carryOffset = carryMatrix.clone().invert().multiply(pickupMatrix);
        }
        heldBy.updateWorldMatrix(true, false);
        localCupMatrix.copy(heldBy.matrixWorld).invert().multiply(carryMatrix).multiply(carryOffset);
        localCupMatrix.decompose(cup.position, cup.quaternion, cup.scale);
      } else {
        release(heldBy);
        status.textContent = 'Hand/controller tracking lost. Aim at the cup to pick it up again.';
      }
    }
    if (heldBy === camera) {
      cup.position.set(0, demoSipping ? -0.11 : -0.18, demoSipping ? -0.12 : -0.42);
      cup.quaternion.copy(headQuaternion).invert();
      if (demoSipping) cup.rotateX(Math.PI / 4);
    }

    rimPosition.set(0, 0.13, 0);
    cup.localToWorld(rimPosition);
    cup.getWorldQuaternion(cupQuaternion);
    up.set(0, 1, 0).applyQuaternion(cupQuaternion);
    const previousSipping = drink.sipping;
    drink = advanceDrink(drink, {
      held: heldBy !== null,
      nearMouth: heldBy === camera ? demoSipping : Boolean(viewerPose) && isNearMouth(rimPosition, mouthPosition),
      tilted: heldBy === camera ? demoSipping : isDrinkingTilt(up.y),
      deltaSeconds,
    });
    const height = Math.max(0.001, 0.105 * drink.fill);
    liquid.scale.y = height / 0.105;
    liquid.position.y = 0.005 + height / 2;
    liquidTop.position.y = 0.005 + height;
    liquid.visible = liquidTop.visible = drink.fill > 0;
    const percent = Math.ceil(drink.fill * 100);
    if (percent !== lastPercent) {
      $('#remaining').innerHTML = `${percent}<span>%</span>`;
      lastPercent = percent;
    }
    if (drink.sipping && !previousSipping) status.textContent = 'Sipping! Virtual liquid is draining.';
    if (!drink.sipping && previousSipping) {
      status.textContent = drink.fill === 0 ? 'All gone. Refill to try again.' : 'Sip finished. Tilt near your mouth for another.';
    }

    halo.visible = cup.visible && !heldBy;
    cup.getWorldPosition(worldPosition);
    halo.position.copy(worldPosition);
    halo.position.y += 0.001;
    if (inXR) {
      const active = controllers.find((controller) => controller.userData.tracked && controller.visible);
      marker.visible = !placed && Boolean(active);
      if (marker.visible) marker.position.copy(placementPoint(active));
      const instruction = !placed
        ? 'Aim the ring at the real glass.\nPinch / trigger to mark. Move hand to adjust depth.'
        : drink.fill === 0
          ? 'All gone! Pinch / trigger to reset.\nLeave the real glass on the table.'
          : heldBy
            ? `Bring cup to mouth and tilt. ${percent}% left.\nRelease to put down. Left grip: reset.`
            : `Aim at virtual cup; hold pinch / trigger.\n${percent}% left. Left controller grip: reset.`;
      updatePanel(instruction);
    }
    renderer.render(scene, camera);
  });

  if (!window.isSecureContext) {
    enterButton.textContent = 'HTTPS required';
    status.textContent = 'Open the HTTPS address in Meta Quest Browser. WebXR requires a secure connection.';
  } else if (!navigator.xr) {
    enterButton.textContent = 'Open on your Quest';
    status.textContent = 'Desktop preview is available here. Open this site in Meta Quest Browser for passthrough.';
  } else {
    try {
      const supported = await navigator.xr.isSessionSupported('immersive-ar');
      enterButton.disabled = !supported;
      enterButton.textContent = supported ? 'Enter mixed reality' : 'Mixed reality unavailable';
      status.textContent = supported
        ? 'Ready. Keep the real glass on the table and clear the space around you.'
        : 'This browser does not support immersive passthrough. Use Meta Quest Browser.';
    } catch (error) {
      enterButton.textContent = 'Headset check failed';
      showError('Unable to check mixed-reality support.', error);
    }
  }
}

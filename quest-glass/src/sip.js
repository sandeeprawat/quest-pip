export function createDrink() {
  return { fill: 1, sips: 0, sipping: false };
}

export function advanceDrink(drink, { held, nearMouth, tilted, deltaSeconds }) {
  if (!Number.isFinite(deltaSeconds) || deltaSeconds < 0) {
    throw new RangeError('deltaSeconds must be finite and non-negative.');
  }
  const sipping = held && nearMouth && tilted && drink.fill > 0;
  const fill = sipping
    ? Math.max(0, drink.fill - Math.min(deltaSeconds, 0.1) * 0.3)
    : drink.fill;
  return {
    fill,
    sips: drink.sips + (sipping && !drink.sipping ? 1 : 0),
    sipping,
  };
}

export function isNearMouth(rim, mouth) {
  return Math.hypot(rim.x - mouth.x, rim.y - mouth.y, rim.z - mouth.z) < 0.14;
}

export function isDrinkingTilt(upDotWorldUp) {
  return upDotWorldUp < Math.cos(Math.PI / 6) && upDotWorldUp > -0.5;
}

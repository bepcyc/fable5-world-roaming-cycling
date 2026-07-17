/**
 * Cycling power<->speed physics and the HR-based calorie model.
 *
 * Defaults model an 80 kg rider on a 9 kg bike in 15 C air; callers can
 * override athlete/bike weight, drivetrain loss and air density with a
 * PowerSpeedConfig and the derived terms recompute. Pure TS.
 */

import { ActivityType } from './Model';

export interface PowerSpeedConfig {
  driveTrainLossPercent: number; // default 2
  athleteWeightKg: number; // default 80
  bikeWeightKg: number; // default 9
  rollingResistanceCoefficient: number; // default 0.005
  dragCoefficient: number; // default 0.63
  frontalArea: number; // m^2, default 0.509
  airDensity: number; // kg/m^3, default 1.226 (15 C)
  dragForceTunePercent: number; // default 1.0 (100%)
}

export const DEFAULT_POWER_SPEED_CONFIG: PowerSpeedConfig = {
  driveTrainLossPercent: 2,
  athleteWeightKg: 80,
  bikeWeightKg: 9,
  rollingResistanceCoefficient: 0.005,
  dragCoefficient: 0.63,
  frontalArea: 0.509,
  airDensity: 1.226,
  dragForceTunePercent: 1.0,
};

const G_CONST = 9.8067;

/** Air temperature (C) -> density (kg/m^3). */
export const airTemperatureToDensity: Readonly<Record<number, number>> = {
  35: 1.1455,
  30: 1.1644,
  25: 1.1839,
  20: 1.2041,
  15: 1.226,
  10: 1.2466,
  5: 1.269,
  0: 1.2922,
  '-5': 1.3163,
  '-10': 1.3413,
  '-15': 1.3673,
  '-20': 1.3943,
  '-25': 1.4224,
};

export class PowerSpeed {
  private a: number; // 0.5*frontalArea*dragCoefficient*airDensity*dragForceTunePercent
  private c: number; // g*(athleteWeight+bikeWeight)*rollingResistanceCoefficient
  private q: number; // c/(3a)
  private driveTrainFraction: number;
  private readonly velocityForPowerDict = new Map<number, number>();

  constructor(cfg: PowerSpeedConfig = DEFAULT_POWER_SPEED_CONFIG) {
    this.a =
      0.5 * cfg.frontalArea * cfg.dragCoefficient * cfg.airDensity * cfg.dragForceTunePercent;
    this.c = G_CONST * (cfg.athleteWeightKg + cfg.bikeWeightKg) * cfg.rollingResistanceCoefficient;
    this.q = this.c / (3 * this.a);
    this.driveTrainFraction = 1.0 - cfg.driveTrainLossPercent / 100.0;
  }

  /** Sport factor: Run/Rowing/NordicSki 1.9; Kayaking/Canoeing/Swim 3.0; else 1.0. */
  sportFactor(sport: string): number {
    switch (sport) {
      case ActivityType.run:
      case ActivityType.rowing:
      case ActivityType.nordicSki:
        return 1.9;
      case ActivityType.kayaking:
      case ActivityType.canoeing:
      case ActivityType.swim:
        return 3.0;
      default:
        // Ride / Elliptical / anything else
        return 1.0;
    }
  }

  /** Watts required to hold velocity v (m/s) for the given sport. */
  powerForVelocity(velocity: number, sport: string): number {
    return (
      (((this.c + this.a * velocity * velocity) * velocity) / this.driveTrainFraction) *
      this.sportFactor(sport)
    );
  }

  /**
   * Solve a*v^3 + c*v = driveTrainFraction*power for v (m/s) via Cardano's
   * method (sport factor NOT applied; the cycling model). Memoized per integer
   * power.
   */
  velocityForPowerCardano(power: number): number {
    const cached = this.velocityForPowerDict.get(power);
    if (cached !== undefined) return cached;

    const dNeg = this.driveTrainFraction * power;
    const r = dNeg / (2 * this.a);
    const e = Math.sqrt(this.q * this.q * this.q + r * r);
    const third = 1 / 3;
    const rAddE = r + e;
    // Sign-preserving cube root (Math.pow rejects negative bases).
    const s = rAddE > 0 ? Math.pow(rAddE, third) : -Math.pow(-rAddE, third);
    const rSubE = r - e;
    const t = rSubE > 0 ? Math.pow(rSubE, third) : -Math.pow(-rSubE, third);
    const speed = s + t;

    this.velocityForPowerDict.set(power, speed);
    return speed;
  }
}

export const athleteVO2MaxMin = 0; // vo2Max must exceed this to use the vo2 model

/**
 * HR-based energy rate (kcal/min). weight in kg, age in years. Uses the vo2Max
 * model when vo2Max exceeds athleteVO2MaxMin, otherwise the simpler estimate.
 */
export function hrBasedCaloriesPerMinute(
  heartRate: number,
  weight: number,
  age: number,
  isMale: boolean,
  vo2Max: number,
): number {
  if (vo2Max > athleteVO2MaxMin) {
    if (isMale) {
      return (
        (-59.3954 + (-36.3781 + 0.271 * age + 0.394 * weight + 0.404 * vo2Max + 0.634 * heartRate)) /
        4.184
      );
    }
    return (-59.3954 + (0.274 * age + 0.103 * weight + 0.38 * vo2Max + 0.45 * heartRate)) / 4.184;
  }
  if (isMale) {
    return (-55.0969 + 0.6309 * heartRate + 0.1988 * weight + 0.2017 * age) / 4.184;
  }
  return (-20.4022 + 0.4472 * heartRate - 0.1263 * weight + 0.074 * age) / 4.184;
}

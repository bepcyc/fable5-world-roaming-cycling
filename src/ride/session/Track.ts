/**
 * Synthetic GPS oval-track math. Exports embed coordinates on a fixed oval
 * chosen by the device's time zone; there is no real GPS. Provides the track
 * geometry, a calculator (distance -> lon/lat for files, distance -> screen
 * pixels for an on-screen oval, plus haversine/vincenty/degrees-per-meter
 * helpers), and a manager that picks a track per sport + time zone. Pure TS.
 */

import { eps } from './Model';
import { ActivityType } from './Model';

// ---- track constants --------------------------------------------------------
export const thick = 15.0;
export const trackLength = 400.0; // meters
export const fourHundredMTrackLengthFactor = 1.0;
export const fiveHundredMTrackLengthFactor = 1.25; // 500 m, water
export const trackQuarter = trackLength / 4.0; // 100 m
export const trackPaintingRadiusBoost = 1.2;

export type TrackKind = 'forRun' | 'forRide' | 'forLand' | 'forWater';

/** A geographic point, dx = longitude, dy = latitude. */
export interface LonLat {
  dx: number; // longitude
  dy: number; // latitude
}

export interface TrackDescriptorInit {
  name: string;
  kind: TrackKind;
  center: LonLat;
  radiusBoost: number;
  horizontalMeter?: number; // degrees per meter (lon)
  verticalMeter?: number; // degrees per meter (lat)
  altitude?: number; // m
  lengthFactor?: number; // override (long track = 4.15)
}

export class TrackDescriptor {
  readonly name: string;
  readonly kind: TrackKind;
  readonly center: LonLat;
  readonly radiusBoost: number;
  readonly horizontalMeter: number;
  readonly verticalMeter: number;
  readonly altitude: number;
  lengthFactor: number;

  constructor(init: TrackDescriptorInit) {
    this.name = init.name;
    this.kind = init.kind;
    this.center = init.center;
    this.radiusBoost = init.radiusBoost;
    this.horizontalMeter = init.horizontalMeter ?? eps;
    this.verticalMeter = init.verticalMeter ?? eps;
    this.altitude = init.altitude ?? 0.0;
    this.lengthFactor =
      init.lengthFactor ??
      (init.kind === 'forWater' ? fiveHundredMTrackLengthFactor : fourHundredMTrackLengthFactor);
  }

  get halfCircle(): number {
    return trackQuarter * this.lengthFactor * this.radiusBoost;
  }
  get laneShrink(): number {
    return 2.0 - this.radiusBoost;
  }
  get laneLength(): number {
    return trackQuarter * this.lengthFactor * this.laneShrink;
  }
  get radius(): number {
    return this.halfCircle / Math.PI;
  }
  get laneHalf(): number {
    return this.laneLength / 2.0;
  }
  get length(): number {
    return trackLength * this.lengthFactor;
  }
}

// ---- TrackCalculator --------------------------------------------------------
export class TrackCalculator {
  readonly track: TrackDescriptor;

  constructor(track: TrackDescriptor) {
    this.track = track;
  }

  /** distance (m) -> (lon, lat) on the oval. This traversal starts on the left
   *  straight (the screen-pixel traversal starts on the bottom straight). */
  gpsCoordinates(distance: number): LonLat {
    const trackLen = this.track.length;
    const d = mod(distance, trackLen);

    let cx = 0;
    let cy = 0;
    if (d <= this.track.laneLength) {
      // left straight (going "up")
      cx = -this.track.radius;
      cy = this.track.laneHalf - d;
    } else if (d <= trackLen / 2) {
      // top semicircle
      const rad = ((d - this.track.laneLength) / this.track.halfCircle) * Math.PI;
      cx = -Math.cos(rad) * this.track.radius;
      cy = -this.track.laneHalf - Math.sin(rad) * this.track.radius;
    } else if (d <= trackLen / 2 + this.track.laneLength) {
      // right straight
      const disp = d - trackLen / 2;
      cx = this.track.radius;
      cy = -this.track.laneHalf + disp;
    } else {
      // bottom semicircle
      const rad = ((d - trackLen / 2 - this.track.laneLength) / this.track.halfCircle) * Math.PI;
      cx = Math.cos(rad) * this.track.radius;
      cy = this.track.laneHalf + Math.sin(rad) * this.track.radius;
    }

    // lon, lat order
    return {
      dx: this.track.center.dx + cx * this.track.horizontalMeter,
      dy: this.track.center.dy + cy * this.track.verticalMeter,
    };
  }

  /** Great-circle distance (m) between two lat/lon points. */
  static haversineDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const dLat = radians(lat2 - lat1);
    const dLon = radians(lon2 - lon1);
    const latSin = Math.sin(dLat / 2.0);
    const lonSin = Math.sin(dLon / 2.0);
    const a =
      latSin * latSin + lonSin * lonSin * Math.cos(radians(lat1)) * Math.cos(radians(lat2));
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    const earthRadiusM = 6371008;
    return earthRadiusM * c;
  }

  /** WGS-84 ellipsoidal distance (m) between two lat/lon points. */
  static vincentyDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const a = 6378137.0;
    const b = 6356752.314245;
    const f = 1 / 298.257223563;

    const L = radians(lon2 - lon1);
    const u1 = Math.atan((1 - f) * Math.tan(radians(lat1)));
    const u2 = Math.atan((1 - f) * Math.tan(radians(lat2)));
    const sinU1 = Math.sin(u1);
    const cosU1 = Math.cos(u1);
    const sinU2 = Math.sin(u2);
    const cosU2 = Math.cos(u2);

    let lambda = L;
    let lambdaP = 2 * Math.PI;
    let iterationLimit = 100;

    let sinSigma = 0.0;
    let cosSigma = 0.0;
    let sigma = 0.0;
    let cosSqAlpha = 0.0;
    let cos2SigmaM = 0.0;

    while (Math.abs(lambda - lambdaP) > 1e-12 && --iterationLimit > 0) {
      const sinLambda = Math.sin(lambda);
      const cosLambda = Math.cos(lambda);
      sinSigma = Math.sqrt(
        Math.pow(cosU2 * sinLambda, 2) + Math.pow(cosU1 * sinU2 - sinU1 * cosU2 * cosLambda, 2),
      );
      if (sinSigma === 0) return 0;
      cosSigma = sinU1 * sinU2 + cosU1 * cosU2 * cosLambda;
      sigma = Math.atan2(sinSigma, cosSigma);
      const sinAlpha = (cosU1 * cosU2 * sinLambda) / sinSigma;
      cosSqAlpha = 1.0 - Math.pow(sinAlpha, 2);
      cos2SigmaM = cosSigma - (2 * sinU1 * sinU2) / cosSqAlpha;
      if (Number.isNaN(cos2SigmaM)) cos2SigmaM = 0;
      const C = (f / 16) * cosSqAlpha * (4 + f * (4 - 3 * cosSqAlpha));
      lambdaP = lambda;
      lambda =
        L +
        (1 - C) *
          f *
          sinAlpha *
          (sigma + C * sinSigma * (cos2SigmaM + C * cosSigma * (-1 + 2 * Math.pow(cos2SigmaM, 2))));
    }

    if (iterationLimit === 0) return NaN;

    const uSq = (cosSqAlpha * (Math.pow(a, 2) - Math.pow(b, 2))) / Math.pow(b, 2);
    const A = 1 + (uSq / 16384) * (4096 + uSq * (-768 + uSq * (320 - 175 * uSq)));
    const B = (uSq / 1024) * (256 + uSq * (-128 + uSq * (74 - 47 * uSq)));
    const deltaSigma =
      B *
      sinSigma *
      (cos2SigmaM +
        (B / 4) *
          (cosSigma * (-1 + 2 * Math.pow(cos2SigmaM, 2)) -
            (B / 6) *
              cos2SigmaM *
              (-3 + 4 * Math.pow(sinSigma, 2)) *
              (-3 + 4 * Math.pow(cos2SigmaM, 2))));

    return b * A * (sigma - deltaSigma);
  }

  /** WGS-84 degrees per meter at a latitude -> (lonDegPerM, latDegPerM). */
  static degreesPerMeter(latitude: number): LonLat {
    const a = 6378137.0;
    const b = 6356752.314245;
    const e2 = 1.0 - Math.pow(b / a, 2);
    const phi = radians(latitude);
    const sinPhi = Math.sin(phi);
    const cosPhi = Math.cos(phi);
    const e2SinPhiSq = e2 * sinPhi * sinPhi;
    const N = a / Math.sqrt(1 - e2SinPhiSq);
    const R = (N * (1 - e2)) / (1 - e2SinPhiSq);
    const tmp = (a * (1 - e2)) / Math.pow(1 - e2SinPhiSq, 1.5);
    const D = Math.sqrt(1 - e2SinPhiSq);
    const S = tmp * D;
    return { dx: degrees(1 / (R * cosPhi)), dy: degrees(1 / S) };
  }
}

function radians(deg: number): number {
  return (deg * Math.PI) / 180;
}
function degrees(rad: number): number {
  return (rad * 180) / Math.PI;
}
/** Modulo that keeps the sign of the divisor (values here are >= 0). */
function mod(a: number, b: number): number {
  return ((a % b) + b) % b;
}

// ---- sport -> track-kind preference -----------------------------------------
const trackKindSportMap: Readonly<Record<string, TrackKind[]>> = {
  [ActivityType.ride]: ['forRide', 'forLand'],
  [ActivityType.virtualRide]: ['forRide', 'forLand'],
  [ActivityType.run]: ['forRun', 'forLand'],
  [ActivityType.virtualRun]: ['forRun', 'forLand'],
  [ActivityType.elliptical]: ['forRun', 'forLand'],
  [ActivityType.stairStepper]: ['forRun', 'forLand'],
  [ActivityType.kayaking]: ['forWater'],
  [ActivityType.canoeing]: ['forWater'],
  [ActivityType.rowing]: ['forWater'],
  [ActivityType.swim]: ['forWater'],
};

export function getTrackKindForSport(sport: string): TrackKind[] {
  return trackKindSportMap[sport] ?? ['forLand'];
}

// ---- TrackManager -----------------------------------------------------------
type ZoneTracks = Partial<Record<TrackKind, TrackDescriptor>>;

function td(
  name: string,
  kind: TrackKind,
  lon: number,
  lat: number,
  radiusBoost: number,
  horizontalMeter: number,
  verticalMeter: number,
  altitude: number,
): TrackDescriptor {
  return new TrackDescriptor({
    name,
    kind,
    center: { dx: lon, dy: lat },
    radiusBoost,
    horizontalMeter,
    verticalMeter,
    altitude,
  });
}

/** Standard UTC offsets (minutes) for the track zones — a DST-free fallback for
 *  the closest-offset selection when the runtime cannot resolve a zone. */
export const TRACK_TZ_OFFSETS_MIN: Readonly<Record<string, number>> = {
  'Pacific/Honolulu': -600,
  'America/Anchorage': -540,
  'America/Los_Angeles': -480,
  'America/Phoenix': -420,
  'America/Chicago': -360,
  'America/New_York': -300,
  'America/Caracas': -270,
  'America/Halifax': -240,
  'America/Sao_Paulo': -180,
  'Atlantic/Cape_Verde': -60,
  'Europe/London': 0,
  'Europe/Berlin': 60,
  'Europe/Bucharest': 120,
  'Europe/Istanbul': 180,
  'Asia/Tehran': 210,
  'Asia/Yerevan': 240,
  'Asia/Kabul': 270,
  'Asia/Karachi': 300,
  'Asia/Kolkata': 330,
  'Asia/Almaty': 360,
  'Asia/Ho_Chi_Minh': 420,
  'Australia/Perth': 480,
  'Asia/Seoul': 540,
  'Australia/Adelaide': 570,
  'Australia/Darwin': 570,
  'Australia/Sydney': 600,
  'Pacific/Auckland': 720,
};

export interface GetTrackOptions {
  timeZone: string; // IANA tz of the device
  useLongTrack?: boolean;
  now?: Date; // instant used for offset resolution (default now)
}

export class TrackManager {
  readonly trackMaps: Map<string, ZoneTracks> = new Map([
    [
      'Pacific/Honolulu',
      {
        forLand: td('AlohaStadium', 'forLand', -157.929905, 21.369667, 1.1, 0.000009698416988606145, 0.000009035656281334384, 7.0),
        forWater: td('AieaBay', 'forWater', -157.941302, 21.372486, 1.2, 0.000009698600458559296, 0.000009035654259681184, 0.0),
      },
    ],
    [
      'America/Anchorage',
      {
        forLand: td('MulcahyStadium', 'forLand', -149.874875, 61.20489, 1.1, 0.00001863075553310742, 0.000008997199449431521, 19.0),
        forWater: td('LakeSpenard', 'forWater', -149.951304, 61.178096, 1.2, 0.000018614993965519817, 0.00000899722335858121, 24.0),
      },
    ],
    [
      'America/Los_Angeles',
      {
        forRun: td('Marymoor', 'forRun', -122.112045, 47.665821, 1.2, 0.000013355210232154847, 0.000009010611013606429, 14.0),
        forRide: td('Hoover', 'forRide', -119.768433, 36.8195, 1.1, 0.000011256451440995568, 0.00000902195078566701, 96.0),
        forWater: td('SanJoaquinBluffPointe', 'forWater', -119.8730278, 36.84823845, 1.2, 0.000011260626645287636, 0.000009021921644395027, 68.0),
      },
    ],
    [
      'America/Phoenix',
      {
        forLand: td('UofPStadiumYellowLot', 'forLand', -112.256361, 33.528765, 1.1, 0.000010815629770411326, 0.000009025223629594078, 324.0),
        forWater: td('LakeSpenard', 'forWater', -111.52613, 33.570095, 1.2, 0.000010820732239955627, 0.000009025183400301989, 464.0),
      },
    ],
    [
      'America/Chicago',
      {
        forLand: td('VanderbiltLot74-75', 'forLand', -86.811341, 36.140955, 1.1, 0.000011159579913486331, 0.00000902263628444984, 169.0),
        forWater: td('CumberlandRiverDam', 'forWater', -86.6455, 36.286503, 1.2, 0.000011180085194845976, 0.000009022489667173262, 134.0),
      },
    ],
    [
      'America/New_York',
      {
        forLand: td('JonesBeachParkingLot', 'forLand', -73.505493, 40.598631, 1.1, 0.000011860160892111312, 0.000009018056264220976, 0.0),
        forWater: td('ZachsBay', 'forWater', -73.489754, 40.601998, 1.2, 0.000011860751348913953, 0.000009018052748334848, 0.0),
      },
    ],
    [
      'America/Caracas',
      {
        forLand: td('RadiofaroOmnidireccionalVHFMaiquetia', 'forLand', -66.98968, 10.60948, 1.1, 0.00000919785482499578, 0.00000904164252270872, 71.0),
        forWater: td('PoertoLaGuaira', 'forWater', -66.940208, 10.600946, 1.2, 0.000009197603291524593, 0.000009041645785188901, 0.0),
      },
    ],
    [
      'America/Halifax',
      {
        forLand: td('TrailerParkBoysLot', 'forLand', -63.542753, 44.673775, 1.1, 0.000012654440067482906, 0.000009013768506004187, 63.0),
        forWater: td('MorrisLake', 'forWater', -63.496622, 44.651401, 1.2, 0.000012649607075420199, 0.000009013792145985222, 28.0),
      },
    ],
    [
      'America/Sao_Paulo',
      {
        forLand: td('RioDeJaneiroAirport', 'forLand', -43.164751, -22.912775, 1.1, 0.0000098034378490387, 0.000009034517986519815, 7.0),
        forWater: td('LagueRodrigoDeFreitas', 'forWater', -43.211437, -22.972039, 1.2, 0.000009807657817037495, 0.000009034473027818108, 6.0),
      },
    ],
    [
      'Atlantic/Cape_Verde',
      {
        forLand: td('SalinasPortoInglesMaioLand', 'forLand', -23.222874, 15.150392, 1.1, 0.000009362918055549223, 0.000009039559413062688, 0.0),
        forWater: td('SalinasPortoInglesMaioWater', 'forWater', -23.222874, 15.150392, 1.2, 0.000009362918055549223, 0.000009039559413062688, 0.0),
      },
    ],
    [
      'Europe/London',
      {
        forLand: td('GatwickAirportSideTarmac', 'forLand', -0.187445, 51.153249, 1.1, 0.000014330516727319572, 0.000009006971816326896, 56.0),
        forWater: td('WraysburyReservoir', 'forWater', -0.524808, 51.462237, 1.2, 0.000014426568368254354, 0.000009006653206141612, 28.0),
      },
    ],
    [
      'Europe/Berlin',
      {
        forLand: td('FlughafenTemplehofenFeld', 'forLand', 13.390212, 52.47891, 1.1, 0.000014755074926940898, 0.000009005610631341033, 37.0),
        forWater: td('GroserMueggelsee', 'forWater', 13.646848, 52.437737, 1.2, 0.000014741387208870937, 0.000009005652670950831, 31.0),
      },
    ],
    [
      'Europe/Bucharest',
      {
        forLand: td('BaneasaShoppingCityParkingLot', 'forLand', 26.087319, 44.508728, 1.1, 0.000012618921053063136, 0.000009013942885914843, 88.0),
        forWater: td('LaculMorii', 'forWater', 26.033653, 44.452841, 1.2, 0.000012606963141841854, 0.000009014001929540782, 81.0),
      },
    ],
    [
      'Europe/Istanbul',
      {
        forLand: td('IstanbulHavalimaniSideTarmac', 'forLand', 28.716875, 41.295379, 1.1, 0.000011984512861346388, 0.00000901732741488997, 60.0),
        forWater: td('GoldenHornIstanbul', 'forWater', 28.959516, 41.030587, 1.2, 0.000011936737079234084, 0.00000901760470207289, 0.0),
      },
    ],
    [
      'Asia/Tehran',
      {
        forLand: td('MehrabadAirBaseSideTarmac', 'forLand', 51.314826, 35.683827, 1.1, 0.000011096131570264502, 0.00000902309520698465, 1174.0),
        forWater: td('ChitgarLakeTehran', 'forWater', 51.21389, 35.745086, 1.2, 0.000011104551027084707, 0.000009023033847830158, 1268.0),
      },
    ],
    [
      'Asia/Yerevan',
      {
        forLand: td('YerevanAirportSideTarmac', 'forLand', 44.407696, 40.150749, 1.1, 0.00001178250428060003, 0.000009018523361780945, 860.0),
        forWater: td('YerevanyanLake', 'forWater', 44.477948, 40.160367, 1.2, 0.000011784153573070084, 0.000009018513343826004, 906.0),
      },
    ],
    [
      'Asia/Kabul',
      {
        forLand: td('KabulAirportSideTarmac', 'forLand', 69.217713, 34.568202, 1.1, 0.000010947185845459222, 0.00000902420463924903, 1788.0),
        forWater: td('QuarghaReservoir', 'forWater', 69.033618, 34.556452, 1.2, 0.000010945660511757018, 0.000009024216239963698, 1987.0),
      },
    ],
    [
      'Asia/Karachi',
      {
        forLand: td('JinnahAirportSideTarmacKarachi', 'forLand', 67.148441, 24.897003, 1.1, 0.000009952533007033857, 0.00000903296485138172, 17.0),
        forWater: td('LagoonNearKarachiPort', 'forWater', 66.954419, 24.840263, 1.2, 0.000009948041190330462, 0.00000903301060210796, 0.0),
      },
    ],
    [
      'Asia/Kolkata',
      {
        forLand: td('SarbarVallabhbhaiPatelAirportAhmedabadGujarat', 'forLand', 72.626126, 23.073872, 1.1, 0.000009814941800312108, 0.000009034395565263796, 72.0),
        forWater: td('KankariaLakeAhmedabad', 'forWater', 72.599662, 23.00622, 1.2, 0.000009810098106641359, 0.000009034447056544187, 67.0),
      },
    ],
    [
      'Asia/Almaty',
      {
        forLand: td('AlmatyAirport', 'forLand', 77.014195, 43.343786, 1.1, 0.000012376713703099066, 0.000009015172879606861, 676.0),
        forWater: td('LakeSorbulaq', 'forWater', 76.57194, 43.668614, 1.2, 0.000012442784830818695, 0.000009014830116494367, 618.0),
      },
    ],
    [
      'Asia/Ho_Chi_Minh',
      {
        forLand: td('TanSonNhatAirportSideTarmac', 'forLand', 106.660137, 10.812661, 1.1, 0.000009203906785280708, 0.000009041564109353537, 10.0),
        forWater: td('HoDaLake', 'forWater', 106.794638, 10.882972, 1.2, 0.000009206029433853195, 0.000009041518993791423, 10.0),
      },
    ],
    [
      'Australia/Perth',
      {
        forLand: td('PerthAirportSideTarmac', 'forLand', 115.968893, -31.946402, 1.1, 0.000010627954877982389, 0.000009026744602970204, 19.0),
        forWater: td('BibraLakePerth', 'forWater', 115.825696, -32.095313, 1.2, 0.000010644992754533823, 0.000009026603129769834, 14.0),
      },
    ],
    [
      'Asia/Seoul',
      {
        forLand: td('IncheonAirportTarmac', 'forLand', 126.438003, 37.463765, 1.1, 0.000011351497186529572, 0.000009021295485039723, 0.0),
        forWater: td('YellowSeaPortofIncheon', 'forWater', 126.610885, 37.465361, 1.2, 0.000011351736434573891, 0.000009021293856621378, 0.0),
      },
    ],
    [
      'Australia/Adelaide',
      {
        forLand: td('GenisSteelParkingLot', 'forLand', 138.651371, -34.751084, 1.1, 0.00001097104161721459, 0.00000902402384822358, 38.0),
        forWater: td('HopeValleyReservoir', 'forWater', 138.682459, -34.851559, 1.2, 0.000010984240217355812, 0.000009023924337670913, 104.0),
      },
    ],
    [
      'Australia/Darwin',
      {
        forLand: td('DarwinAirportSideTarmac', 'forLand', 130.867281, -12.417536, 1.1, 0.000009256026695717555, 0.000009040895328423374, 31.0),
        forWater: td('TimorSeaBay', 'forWater', 130.854498, -12.455684, 1.2, 0.000009257359849370589, 0.000009040878373851225, 0.0),
      },
    ],
    [
      'Australia/Sydney',
      {
        forLand: td('SydneyAirportSideTarmac', 'forLand', 151.188888, -33.936817, 1.1, 0.00001086646784069246, 0.000009024825382462703, 5.0),
        forWater: td('ChippingNortonLake', 'forWater', 150.958685, -33.902295, 1.2, 0.000010862126881176818, 0.000009024859165656107, 2.0),
      },
    ],
    [
      'Pacific/Auckland',
      {
        forLand: td('AucklandAirportTarmac', 'forLand', 174.783718, -37.008289, 1.1, 0.000011283988485219191, 0.000009021759194828584, 6.0),
        forWater: td('PahurehureInlet', 'forWater', 174.87859, -37.061558, 1.2, 0.000011291805168894824, 0.000009021705069417802, 0.0),
      },
    ],
  ]);

  /** A long oval (lengthFactor 4.15) used when the long-track option is on. */
  readonly longTrack = new TrackDescriptor({
    name: 'BrianITatarianGrandstand',
    kind: 'forLand',
    center: { dx: -119.747305, dy: 36.73238 },
    radiusBoost: 1.0,
    horizontalMeter: 0.000011243830715527682,
    verticalMeter: 0.000009022039074256466,
    altitude: 88.0,
    lengthFactor: 4.15,
  });

  /** Pick the synthetic track for a sport + time zone. */
  getTrack(sport: string, opts: GetTrackOptions): TrackDescriptor {
    const trackKinds = getTrackKindForSport(sport);
    if ((opts.useLongTrack ?? false) && !trackKinds.includes('forWater')) {
      return this.longTrack;
    }

    const at = opts.now ?? new Date();
    let trackTimeZone = '';
    if (this.trackMaps.has(opts.timeZone)) {
      trackTimeZone = opts.timeZone;
    } else {
      const timeOffset = this.tzOffsetMinutes(opts.timeZone, at) + 5; // +5 tie-break
      const sorted = [...this.trackMaps.keys()]
        .map((tzName) => ({
          diff: Math.abs(this.tzOffsetMinutes(tzName, at) - timeOffset),
          tzName,
        }))
        .sort((a, b) => a.diff - b.diff); // stable: insertion order breaks ties
      trackTimeZone = sorted[0]?.tzName ?? 'Europe/London';
    }

    const zoneTracks = this.trackMaps.get(trackTimeZone);
    if (zoneTracks) {
      for (const kind of trackKinds) {
        const t = zoneTracks[kind];
        if (t) return t;
      }
    }
    const londonLand = this.trackMaps.get('Europe/London')?.forLand;
    if (londonLand) return londonLand;
    return this.longTrack; // unreachable; London/forLand always present
  }

  /** UTC offset (minutes) for an IANA zone, with a static fallback table. */
  private tzOffsetMinutes(iana: string, at: Date): number {
    try {
      const dtf = new Intl.DateTimeFormat('en-US', {
        timeZone: iana,
        timeZoneName: 'longOffset',
      });
      const parts = dtf.formatToParts(at);
      const tzName = parts.find((p) => p.type === 'timeZoneName')?.value ?? '';
      const m = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(tzName);
      if (m && m[1] && m[2]) {
        const sign = m[1] === '-' ? -1 : 1;
        const hh = parseInt(m[2], 10);
        const mm = m[3] ? parseInt(m[3], 10) : 0;
        return sign * (hh * 60 + mm);
      }
      if (tzName === 'GMT') return 0;
    } catch {
      // zone id unavailable; fall through to the static table.
    }
    return TRACK_TZ_OFFSETS_MIN[iana] ?? 0;
  }
}

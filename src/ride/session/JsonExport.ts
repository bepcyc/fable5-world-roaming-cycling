/**
 * JSON export — Under Armour / MapMyFitness workout schema. Formatting is
 * deliberate: no spaces after commas (only after the ": " key separator),
 * doubles rendered with a trailing ".0" for the time-series timestamps and
 * elevation, and "null" for absent series samples. The time-series "speed"
 * value is the m/s reading multiplied by kmh2ms once more. Pure TS.
 */

import { ActivityType, dartDouble, kmh2ms } from './Model';
import { MeasurementCounter, type ExportModel, type ExportRecord } from './ExportModel';

// ---- sport id mapping -------------------------------------------------------
const underArmourSport: Readonly<Record<string, number>> = {
  [ActivityType.alpineSki]: 74,
  [ActivityType.backcountrySki]: 397,
  [ActivityType.canoeing]: 57,
  [ActivityType.crossfit]: 704,
  [ActivityType.eBikeRide]: 1246,
  [ActivityType.elliptical]: 211,
  [ActivityType.golf]: 154,
  [ActivityType.handcycle]: 1249,
  [ActivityType.hike]: 24,
  [ActivityType.iceSkate]: 86,
  IndoorRowing: 99,
  IndoorRunning: 25,
  [ActivityType.inlineSkate]: 169,
  [ActivityType.kayaking]: 257,
  [ActivityType.kitesurf]: 205,
  [ActivityType.nordicSki]: 1237,
  OpenWaterSwim: 180,
  Paddling: 88,
  [ActivityType.ride]: 36,
  [ActivityType.rockClimbing]: 234,
  [ActivityType.rollerSki]: 1255,
  [ActivityType.rowing]: 128,
  [ActivityType.run]: 16,
  [ActivityType.sail]: 29,
  [ActivityType.skateboard]: 95,
  [ActivityType.snowboard]: 107,
  [ActivityType.snowshoe]: 119,
  [ActivityType.soccer]: 176,
  [ActivityType.stairStepper]: 730,
  [ActivityType.standUpPaddling]: 863,
  [ActivityType.surfing]: 127,
  [ActivityType.swim]: 15,
  Treadmill: 208,
  TrackRide: 44,
  TrackRun: 108,
  [ActivityType.velomobile]: 1,
  [ActivityType.virtualRide]: 19,
  [ActivityType.virtualRun]: 25,
  VirtualRowing: 99,
  [ActivityType.walk]: 9,
  [ActivityType.weightTraining]: 18,
  [ActivityType.wheelchair]: 1201,
  [ActivityType.windsurf]: 94,
  [ActivityType.workout]: 2,
  [ActivityType.yoga]: 78,
};

export function toUnderArmourSport(sport: string): number {
  let s = sport;
  if (s === ActivityType.canoeing) s = ActivityType.kayaking;
  if (!(s in underArmourSport)) s = ActivityType.workout;
  return underArmourSport[s] ?? (underArmourSport[ActivityType.workout] as number);
}

// ---- aggregates -------------------------------------------------------------
function aggregatesJson(model: ExportModel): string {
  return (
    `{"elapsed_time_total": ${model.activity.elapsed},` +
    `"distance_total": ${model.activity.distance.toFixed(2)},` +
    `"speed_min": ${model.minimumSpeed.toFixed(2)},` +
    `"speed_max": ${model.maximumSpeed.toFixed(2)},` +
    `"speed_avg": ${model.averageSpeed.toFixed(2)},` +
    `"power_min": ${model.minimumPower},` +
    `"power_max": ${model.maximumPower},` +
    `"power_avg": ${model.averagePower.toFixed(2)},` +
    `"cadence_min": ${model.minimumCadence},` +
    `"cadence_max": ${model.maximumCadence},` +
    `"cadence_avg": ${model.averageCadence},` +
    `"heartrate_min": ${model.minimumHeartRate},` +
    `"heartrate_max": ${model.maximumHeartRate},` +
    `"heartrate_avg": ${model.averageHeartRate}}`
  );
}

// ---- time series ------------------------------------------------------------
function timeSeries(model: ExportModel): string {
  const counter = new MeasurementCounter(true, model.activity.sport);
  for (const r of model.records) counter.processRecord(r.record);

  const t = (r: ExportRecord): string => dartDouble(r.elapsed(model.activity));
  const parts: string[] = [];

  parts.push(
    '"distance": [' +
      model.records
        .map((r) => `[${t(r)}, ${(r.record.distance ?? 0.0).toFixed(2)}]`)
        .join(',') +
      ']',
  );

  // speed is already m/s; the schema multiplies by kmh2ms once more.
  parts.push(
    ',"speed": [' +
      model.records
        .map((r) => `[${t(r)}, ${((r.record.speed ?? 0.0) * kmh2ms).toFixed(2)}]`)
        .join(',') +
      ']',
  );

  if (counter.hasPower) {
    parts.push(
      ',"power": [' + model.records.map((r) => `[${t(r)}, ${r.record.power}]`).join(',') + ']',
    );
  }
  if (counter.hasCadence) {
    parts.push(
      ',"cadence": [' + model.records.map((r) => `[${t(r)}, ${r.record.cadence}]`).join(',') + ']',
    );
  }
  if (counter.hasHeartRate) {
    parts.push(
      ',"heartrate": [' +
        model.records.map((r) => `[${t(r)}, ${r.record.heartRate}]`).join(',') +
        ']',
    );
  }
  if (!model.rawData && model.calculateGps) {
    parts.push(
      ',"position": [' +
        model.records
          .map(
            (r) =>
              `[${t(r)}, {"lat": ${r.latitude.toFixed(7)}, "lng": ${r.longitude.toFixed(7)}, "elevation": ${dartDouble(model.altitude)}}]`,
          )
          .join(',') +
        ']',
    );
  }
  return parts.join('');
}

/** Encode the workout JSON as UTF-8 bytes. */
export function encodeJson(model: ExportModel): Uint8Array {
  return new TextEncoder().encode(encodeJsonString(model));
}

export function encodeJsonString(model: ExportModel): string {
  const activityType = toUnderArmourSport(model.activity.sport);
  return (
    `{"name": "${model.activity.title}",` +
    `"activity_type": "/v7.1/activity_type/${activityType}/",` +
    `"start_datetime": "${model.activity.start.toISOString()}",` +
    `"start_locale_timezone": "${model.activity.timeZone}",` +
    `"aggregates": ${aggregatesJson(model)},` +
    `"time_series": {${timeSeries(model)}}}`
  );
}

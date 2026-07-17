/**
 * TCX export — Garmin TrainingCenterDatabase v2, UTF-8. Emits the element
 * tree, tag order and indentation exactly (each writeln is one line + "\n").
 * Speed is m/s here (already converted in the shared pass). Pure TS.
 */

import { ActivityType, dartDouble } from './Model';
import {
  dataGapWorkaroundNoWorkaround,
  heartRateLimitingWriteZero,
  type ExportModel,
  type ExportRecord,
} from './ExportModel';

const TCX_MAJOR = 1;
const TCX_MINOR = 0;

function tcxSport(sport: string): string {
  return sport === ActivityType.ride || sport === ActivityType.run ? sport : 'Other';
}

/** ISO-8601 UTC timestamp with milliseconds and a trailing Z. */
function timeStampString(dt: Date): string {
  return dt.toISOString();
}

class Sb {
  private s = '';
  writeln(text: string): void {
    this.s += text + '\n';
  }
  toString(): string {
    return this.s;
  }
}

function addElement(sb: Sb, tag: string, content: string): void {
  sb.writeln(`<${tag}>${content}</${tag}>`);
}

function addPosition(sb: Sb, latitude: string, longitude: string): void {
  sb.writeln(`<Position>
     <LatitudeDegrees>${latitude}</LatitudeDegrees>
     <LongitudeDegrees>${longitude}</LongitudeDegrees>
  </Position>`);
}

function addExtensions(
  sb: Sb,
  tag1: string,
  value1: string,
  tag2: string,
  value2: string,
): void {
  sb.writeln(`    <Extensions>
      <ns3:TPX>
        <ns3:${tag1}>${value1}</ns3:${tag1}>
        <ns3:${tag2}>${value2}</ns3:${tag2}>
      </ns3:TPX>
    </Extensions>`);
}

function addHeartRate(sb: Sb, heartRate: number | null): void {
  const hr = heartRate ?? 0;
  sb.writeln(`              <HeartRateBpm xsi:type="HeartRateInBeatsPerMinute_t">
                <Value>${hr}</Value>
              </HeartRateBpm>`);
}

function addTrackPoint(sb: Sb, record: ExportRecord, model: ExportModel): void {
  sb.writeln('<Trackpoint>');
  addElement(sb, 'Time', timeStampString(record.record.timeStamp ?? model.now));
  if (!model.rawData && model.calculateGps) {
    addPosition(sb, record.latitude.toFixed(7), record.longitude.toFixed(7));
  }
  addElement(sb, 'AltitudeMeters', dartDouble(model.altitude));
  addElement(sb, 'DistanceMeters', (record.record.distance ?? 0.0).toFixed(2));
  if (record.record.cadence !== null) {
    const cadence = Math.trunc(Math.min(Math.max(record.record.cadence, 0), 254));
    addElement(sb, 'Cadence', `${cadence}`);
  }
  addExtensions(
    sb,
    'Speed',
    (record.record.speed ?? 0.0).toFixed(2),
    'Watts',
    (record.record.power ?? 0).toFixed(1),
  );
  if (
    (record.record.heartRate ?? 0) > 0 ||
    model.heartRateGapWorkaround === dataGapWorkaroundNoWorkaround ||
    model.heartRateLimitingMethod === heartRateLimitingWriteZero
  ) {
    addHeartRate(sb, record.record.heartRate);
  }
  sb.writeln('</Trackpoint>');
}

function addTrack(sb: Sb, model: ExportModel): void {
  sb.writeln('          <Track>');
  for (const record of model.records) addTrackPoint(sb, record, model);
  sb.writeln('          </Track>');
}

function addLap(sb: Sb, model: ExportModel): void {
  sb.writeln(`        <Lap StartTime="${timeStampString(model.activity.start)}">`);
  addElement(sb, 'TotalTimeSeconds', model.activity.elapsed.toFixed(1));
  addElement(sb, 'DistanceMeters', model.activity.distance.toFixed(2));
  addElement(sb, 'MaximumSpeed', model.maximumSpeed.toFixed(2));
  if (model.averageHeartRate > 0) {
    addElement(sb, 'AverageHeartRateBpm', model.averageHeartRate.toFixed(2));
  }
  if (model.maximumHeartRate > 0) {
    addElement(sb, 'MaximumHeartRateBpm', `${model.maximumHeartRate}`);
  }
  if (model.averageCadence > 0) {
    const cadence = Math.trunc(Math.min(Math.max(model.averageCadence, 0), 254));
    addElement(sb, 'Cadence', cadence.toFixed(2));
  }
  addElement(sb, 'Calories', `${model.activity.calories}`);
  addElement(sb, 'Intensity', 'Active');
  addElement(sb, 'TriggerMethod', 'Manual');
  addTrack(sb, model);
  sb.writeln('        </Lap>');
}

function addCreator(sb: Sb, model: ExportModel): void {
  sb.writeln(`    <Creator xsi:type="Device_t">
      <Name>${model.descriptor.fullName}</Name>
      <UnitId>${model.activity.deviceId}</UnitId>
      <ProductID>${model.descriptor.modelName}</ProductID>
      <Version>
        <VersionMajor>${TCX_MAJOR}</VersionMajor>
        <VersionMinor>${TCX_MINOR}</VersionMinor>
        <BuildMajor>${TCX_MAJOR}</BuildMajor>
        <BuildMinor>${TCX_MINOR}</BuildMinor>
      </Version>
    </Creator>`);
}

function addActivity(sb: Sb, model: ExportModel): void {
  const activityType = tcxSport(model.activity.sport);
  sb.writeln(`  <Activities>
    <Activity Sport="${activityType}">`);
  addElement(sb, 'Id', timeStampString(model.activity.start));
  addLap(sb, model);
  addCreator(sb, model);
  sb.writeln('    </Activity>');
  sb.writeln('  </Activities>');
}

function addAuthor(sb: Sb, model: ExportModel): void {
  sb.writeln(`  <Author xsi:type="Application_t">
    <Name>${model.author}</Name>
    <Build>
      <Version>
        <VersionMajor>${model.swVersionMajor}</VersionMajor>
        <VersionMinor>${model.swVersionMinor}</VersionMinor>
        <BuildMajor>${model.buildVersionMajor}</BuildMajor>
        <BuildMinor>${model.buildVersionMinor}</BuildMinor>
      </Version>
    </Build>
    <LangID>${model.langID}</LangID>
    <PartNumber>${model.partNumber}</PartNumber>
  </Author>`);
}

/** Encode the TCX document as UTF-8 bytes. */
export function encodeTcx(model: ExportModel): Uint8Array {
  const sb = new Sb();
  sb.writeln(`<?xml version="1.0" encoding="UTF-8"?>
<TrainingCenterDatabase
    xsi:schemaLocation="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2 http://www.garmin.com/xmlschemas/TrainingCenterDatabasev2.xsd"
    xmlns:ns5="http://www.garmin.com/xmlschemas/ActivityGoals/v1"
    xmlns:ns3="http://www.garmin.com/xmlschemas/ActivityExtension/v2"
    xmlns:ns2="http://www.garmin.com/xmlschemas/UserProfile/v2"
    xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2"
    xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:ns4="http://www.garmin.com/xmlschemas/ProfileExtension/v1">`);
  addActivity(sb, model);
  addAuthor(sb, model);
  sb.writeln('</TrainingCenterDatabase>');
  return new TextEncoder().encode(sb.toString());
}

/** TCX text (unencoded), for callers that want a string. */
export function encodeTcxString(model: ExportModel): string {
  return new TextDecoder().decode(encodeTcx(model));
}

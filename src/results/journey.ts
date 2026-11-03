/** Journey legs between consecutive sightings: distance, time and whether the speed is possible. */

export interface JourneyCamera {
  id: string;
  name: string;
  location: {
    latitude: number;
    longitude: number;
    name: string | null;
    heading: number | null;
  } | null;
}

export interface JourneyPoint {
  camera: JourneyCamera;
  first_seen: string;
  last_seen: string;
}

const EARTH_RADIUS_M = 6_371_008.8;

/** Great-circle distance in metres (haversine). */
export function haversineMeters(
  a: { latitude: number; longitude: number },
  b: { latitude: number; longitude: number },
) {
  const rad = Math.PI / 180;
  const dLat = (b.latitude - a.latitude) * rad;
  const dLng = (b.longitude - a.longitude) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.latitude * rad) * Math.cos(b.latitude * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function maxJourneySpeed() {
  const value = Number(process.env.PLATE_JOURNEY_MAX_KMH ?? 150);
  if (!Number.isFinite(value) || value <= 0)
    throw new Error('PLATE_JOURNEY_MAX_KMH must be a positive number');
  return value;
}

/**
 * Leg i goes from point i to point i+1: the time from leaving the first camera to
 * reaching the next, the straight-line distance (null without both locations) and the
 * speed that implies. A leg is implausible when that speed exceeds maxKmh, or when two
 * different cameras saw the plate at overlapping times (two vehicles, or a misread).
 */
export function journeyLegs(points: JourneyPoint[], maxKmh: number) {
  const legs = [];
  for (let i = 0; i + 1 < points.length; i++) {
    const from = points[i],
      to = points[i + 1];
    const gap = (Date.parse(to.first_seen) - Date.parse(from.last_seen)) / 1000;
    const sameCamera = from.camera.id === to.camera.id;
    const distance =
      from.camera.location && to.camera.location
        ? sameCamera
          ? 0
          : haversineMeters(from.camera.location, to.camera.location)
        : null;
    const speed = distance !== null && gap > 0 ? (distance / gap) * 3.6 : null;
    const reasons: string[] = [];
    if (!sameCamera && gap < 0) reasons.push('overlap');
    if (!sameCamera && distance !== null && distance > 0 && (gap <= 0 || (speed ?? 0) > maxKmh))
      reasons.push('too_fast');
    legs.push({
      from: i,
      to: i + 1,
      gap_seconds: Math.round(gap * 10) / 10,
      distance_m: distance === null ? null : Math.round(distance),
      speed_kmh: speed === null ? null : Math.round(speed * 10) / 10,
      implausible: reasons.length > 0,
      reasons,
    });
  }
  return legs;
}

import { z } from 'zod';

/** A camera's location as clients send it; null clears it. */
export const location = z
  .object({
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
    name: z.string().trim().max(200).optional(),
    heading: z.number().int().min(0).max(359).optional(),
  })
  .strict()
  .nullable();
export type Location = z.infer<typeof location>;

/** latitude, longitude, location_name, heading column values of a location. */
export const locationColumns = (value: Location) =>
  value
    ? [value.latitude, value.longitude, value.name || null, value.heading ?? null]
    : [null, null, null, null];

/** The location of a stream_sources row (or a row with its columns) as the API shows it: null until set. */
export function locationView(row: Record<string, any>) {
  return row.latitude === null || row.latitude === undefined
    ? null
    : {
        latitude: row.latitude,
        longitude: row.longitude,
        name: row.location_name ?? null,
        heading: row.heading ?? null,
      };
}

export const locationSchema = {
  type: 'object',
  nullable: true,
  required: ['latitude', 'longitude'],
  additionalProperties: false,
  description: 'Where the camera is (WGS84), for journeys on a map; null clears it.',
  properties: {
    latitude: { type: 'number', minimum: -90, maximum: 90 },
    longitude: { type: 'number', minimum: -180, maximum: 180 },
    name: { type: 'string', maxLength: 200, description: 'Place name, e.g. a street corner' },
    heading: {
      type: 'integer',
      minimum: 0,
      maximum: 359,
      description: 'Compass direction it faces',
    },
  },
};

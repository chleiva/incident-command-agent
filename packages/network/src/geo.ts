/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/** Great-circle helpers on a spherical Earth (R = 6371 km). Pure functions. */

export interface LatLon {
  lat: number;
  lon: number;
}

const R = 6371;
const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

/** Great-circle distance in km (haversine). */
export function haversineKm(a: LatLon, b: LatLon): number {
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Initial true bearing (degrees, 0–360) from a to b. */
export function bearingDeg(a: LatLon, b: LatLon): number {
  const φ1 = rad(a.lat);
  const φ2 = rad(b.lat);
  const Δλ = rad(b.lon - a.lon);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (deg(Math.atan2(y, x)) + 360) % 360;
}

/** The point at fraction f (0–1) along the great circle from a to b (spherical interpolation). */
export function interpolateGreatCircle(a: LatLon, b: LatLon, f: number): LatLon {
  const φ1 = rad(a.lat);
  const λ1 = rad(a.lon);
  const φ2 = rad(b.lat);
  const λ2 = rad(b.lon);
  const δ = haversineKm(a, b) / R;
  if (δ < 1e-9) return { lat: a.lat, lon: a.lon };
  const A = Math.sin((1 - f) * δ) / Math.sin(δ);
  const B = Math.sin(f * δ) / Math.sin(δ);
  const x = A * Math.cos(φ1) * Math.cos(λ1) + B * Math.cos(φ2) * Math.cos(λ2);
  const y = A * Math.cos(φ1) * Math.sin(λ1) + B * Math.cos(φ2) * Math.sin(λ2);
  const z = A * Math.sin(φ1) + B * Math.sin(φ2);
  return { lat: deg(Math.atan2(z, Math.sqrt(x * x + y * y))), lon: deg(Math.atan2(y, x)) };
}

/** Cross-track distance (km) of point p from the great circle through a and b (sign dropped). */
export function crossTrackKm(p: LatLon, a: LatLon, b: LatLon): number {
  const δ13 = haversineKm(a, p) / R;
  const θ13 = rad(bearingDeg(a, p));
  const θ12 = rad(bearingDeg(a, b));
  return Math.abs(Math.asin(Math.sin(δ13) * Math.sin(θ13 - θ12)) * R);
}

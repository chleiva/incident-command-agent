/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * `@ica/network`: Accent Air's fictional network, computed anywhere (browser or Node) at zero cost.
 * - `generateDaySchedule(seed, date)`: the day's flights, tails and crews (deterministic).
 * - `flightStateAt(flight, t)`: phase, position, heading, altitude, ETA, progress, notional endurance.
 * - `suitableAirports(position, type, filters)`: options only, for the commander's consideration.
 */
export * from './geo';
export * from './rng';
export * from './stations';
export * from './schedule';
export * from './state';
export * from './suitability';
export * from './network';

/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * The stations Accent Air (fictional) serves, plus en-route alternates. Coordinates, ICAO codes and UTC offsets are
 * copied from `data/airports/stations.json` (OurAirports, public domain; a test keeps them in sync). The capability
 * data (runway length, fire category, handling, engineering cover, hotels, curfews) is **illustrative**: runway
 * lengths and fire categories are rounded public figures, and everything about Accent Air's contracts, engineering
 * cover and hotel allocations is fictional (each record lists its invented fields in `fictional`).
 */

export type StationRole = 'main_base' | 'base' | 'outstation' | 'alternate';

export interface NetworkStation {
  iata: string;
  icao: string;
  /** OurAirports name. */
  name: string;
  /** Short display name. */
  city: string;
  lat: number;
  lon: number;
  country: string;
  utcStdOffsetMin: number;
  role: StationRole;
}

export type EngineeringCover = 'own' | 'contract' | 'none';

export interface AirportCapability {
  iata: string;
  /** Longest runway, metres (rounded public figure). */
  runwayM: number;
  /** Rescue and fire-fighting (RFFS) category, ICAO scale 1–10 (rounded public figure). */
  rffsCat: number;
  /** Accent Air has a ground-handling contract here (fictional). */
  handlingContract: boolean;
  /** Licensed-engineer cover for Accent Air (fictional). */
  engineering: EngineeringCover;
  customs: boolean;
  /** Hotel rooms Accent Air can hold at short notice (fictional). */
  hotelRooms: number;
  /** Local-time curfew window, if any (fictional simplification). */
  curfew?: { fromLocal: string; toLocal: string };
  /** '24h' or local opening hours 'HH:MM–HH:MM' (fictional where invented). */
  openHours: string;
  /** Which fields are invented for the simulation. */
  fictional: string[];
}

type Raw = Omit<NetworkStation, 'iata' | 'role'>;

const RAW: Record<string, Raw> = {
  MAN: {
    icao: 'EGCC',
    name: 'Manchester Airport',
    city: 'Manchester',
    lat: 53.34938,
    lon: -2.27952,
    country: 'GB',
    utcStdOffsetMin: 0,
  },
  LGW: {
    icao: 'EGKK',
    name: 'London Gatwick Airport',
    city: 'London Gatwick',
    lat: 51.14874,
    lon: -0.18574,
    country: 'GB',
    utcStdOffsetMin: 0,
  },
  EDI: {
    icao: 'EGPH',
    name: 'Edinburgh Airport',
    city: 'Edinburgh',
    lat: 55.95015,
    lon: -3.37229,
    country: 'GB',
    utcStdOffsetMin: 0,
  },
  PMI: {
    icao: 'LEPA',
    name: 'Palma de Mallorca Airport',
    city: 'Palma',
    lat: 39.5517,
    lon: 2.73881,
    country: 'ES',
    utcStdOffsetMin: 60,
  },
  AGP: {
    icao: 'LEMG',
    name: 'Málaga-Costa del Sol Airport',
    city: 'Málaga',
    lat: 36.6749,
    lon: -4.49911,
    country: 'ES',
    utcStdOffsetMin: 60,
  },
  ALC: {
    icao: 'LEAL',
    name: 'Alicante-Elche Miguel Hernández Airport',
    city: 'Alicante',
    lat: 38.2822,
    lon: -0.55816,
    country: 'ES',
    utcStdOffsetMin: 60,
  },
  FAO: {
    icao: 'LPFR',
    name: 'Faro - Gago Coutinho International Airport',
    city: 'Faro',
    lat: 37.01591,
    lon: -7.97094,
    country: 'PT',
    utcStdOffsetMin: 0,
  },
  TFS: {
    icao: 'GCTS',
    name: 'Tenerife Sur Airport',
    city: 'Tenerife South',
    lat: 28.0445,
    lon: -16.5725,
    country: 'ES',
    utcStdOffsetMin: 0,
  },
  LPA: {
    icao: 'GCLP',
    name: 'Gran Canaria Airport',
    city: 'Gran Canaria',
    lat: 27.9319,
    lon: -15.3866,
    country: 'ES',
    utcStdOffsetMin: 0,
  },
  IBZ: {
    icao: 'LEIB',
    name: 'Ibiza Airport',
    city: 'Ibiza',
    lat: 38.8729,
    lon: 1.37312,
    country: 'ES',
    utcStdOffsetMin: 60,
  },
  BCN: {
    icao: 'LEBL',
    name: 'Josep Tarradellas Barcelona-El Prat Airport',
    city: 'Barcelona',
    lat: 41.2971,
    lon: 2.07846,
    country: 'ES',
    utcStdOffsetMin: 60,
  },
  DUB: {
    icao: 'EIDW',
    name: 'Dublin Airport',
    city: 'Dublin',
    lat: 53.42871,
    lon: -6.26212,
    country: 'IE',
    utcStdOffsetMin: 0,
  },
  AMS: {
    icao: 'EHAM',
    name: 'Amsterdam Airport Schiphol',
    city: 'Amsterdam',
    lat: 52.3086,
    lon: 4.76389,
    country: 'NL',
    utcStdOffsetMin: 60,
  },
  CDG: {
    icao: 'LFPG',
    name: 'Charles de Gaulle International Airport',
    city: 'Paris CDG',
    lat: 49.00896,
    lon: 2.55412,
    country: 'FR',
    utcStdOffsetMin: 60,
  },
  GVA: {
    icao: 'LSGG',
    name: 'Geneva International Airport',
    city: 'Geneva',
    lat: 46.2381,
    lon: 6.10895,
    country: 'CH',
    utcStdOffsetMin: 60,
  },
  NCE: {
    icao: 'LFMN',
    name: "Nice-Côte d'Azur Airport",
    city: 'Nice',
    lat: 43.6584,
    lon: 7.21587,
    country: 'FR',
    utcStdOffsetMin: 60,
  },
  LIS: {
    icao: 'LPPT',
    name: 'Lisbon Humberto Delgado Airport',
    city: 'Lisbon',
    lat: 38.7813,
    lon: -9.13592,
    country: 'PT',
    utcStdOffsetMin: 0,
  },
  OPO: {
    icao: 'LPPR',
    name: 'Francisco de Sá Carneiro Airport',
    city: 'Porto',
    lat: 41.2481,
    lon: -8.68139,
    country: 'PT',
    utcStdOffsetMin: 0,
  },
  FCO: {
    icao: 'LIRF',
    name: 'Rome–Fiumicino Leonardo da Vinci International Airport',
    city: 'Rome',
    lat: 41.80453,
    lon: 12.252,
    country: 'IT',
    utcStdOffsetMin: 60,
  },
  PRG: {
    icao: 'LKPR',
    name: 'Václav Havel Airport Prague',
    city: 'Prague',
    lat: 50.10087,
    lon: 14.25991,
    country: 'CZ',
    utcStdOffsetMin: 60,
  },
  BFS: {
    icao: 'EGAA',
    name: 'Belfast International Airport',
    city: 'Belfast',
    lat: 54.6575,
    lon: -6.21583,
    country: 'GB',
    utcStdOffsetMin: 0,
  },
  KRK: {
    icao: 'EPKK',
    name: 'Kraków John Paul II International Airport',
    city: 'Kraków',
    lat: 50.0777,
    lon: 19.7848,
    country: 'PL',
    utcStdOffsetMin: 60,
  },
  CPH: {
    icao: 'EKCH',
    name: 'Copenhagen Kastrup Airport',
    city: 'Copenhagen',
    lat: 55.6179,
    lon: 12.656,
    country: 'DK',
    utcStdOffsetMin: 60,
  },
  VIE: {
    icao: 'LOWW',
    name: 'Vienna International Airport',
    city: 'Vienna',
    lat: 48.1103,
    lon: 16.5697,
    country: 'AT',
    utcStdOffsetMin: 60,
  },
  BOD: {
    icao: 'LFBD',
    name: 'Bordeaux–Mérignac Airport',
    city: 'Bordeaux',
    lat: 44.82865,
    lon: -0.71536,
    country: 'FR',
    utcStdOffsetMin: 60,
  },
  NTE: {
    icao: 'LFRS',
    name: 'Nantes Atlantique Airport',
    city: 'Nantes',
    lat: 47.1532,
    lon: -1.61073,
    country: 'FR',
    utcStdOffsetMin: 60,
  },
  BIO: {
    icao: 'LEBB',
    name: 'Bilbao Airport',
    city: 'Bilbao',
    lat: 43.3011,
    lon: -2.91061,
    country: 'ES',
    utcStdOffsetMin: 60,
  },
  SCQ: {
    icao: 'LEST',
    name: 'Santiago-Rosalía de Castro Airport',
    city: 'Santiago',
    lat: 42.8963,
    lon: -8.41514,
    country: 'ES',
    utcStdOffsetMin: 60,
  },
  LYS: {
    icao: 'LFLL',
    name: 'Lyon Saint-Exupéry Airport',
    city: 'Lyon',
    lat: 45.726,
    lon: 5.09014,
    country: 'FR',
    utcStdOffsetMin: 60,
  },
  MRS: {
    icao: 'LFML',
    name: 'Marseille Provence Airport',
    city: 'Marseille',
    lat: 43.43809,
    lon: 5.2125,
    country: 'FR',
    utcStdOffsetMin: 60,
  },
  VLC: {
    icao: 'LEVC',
    name: 'Valencia Airport',
    city: 'Valencia',
    lat: 39.48916,
    lon: -0.48096,
    country: 'ES',
    utcStdOffsetMin: 60,
  },
  SVQ: {
    icao: 'LEZL',
    name: 'Seville Airport',
    city: 'Seville',
    lat: 37.418,
    lon: -5.89311,
    country: 'ES',
    utcStdOffsetMin: 60,
  },
  MAD: {
    icao: 'LEMD',
    name: 'Adolfo Suárez Madrid–Barajas Airport',
    city: 'Madrid',
    lat: 40.49341,
    lon: -3.57225,
    country: 'ES',
    utcStdOffsetMin: 60,
  },
  ORY: {
    icao: 'LFPO',
    name: 'Paris-Orly Airport',
    city: 'Paris Orly',
    lat: 48.7295,
    lon: 2.35896,
    country: 'FR',
    utcStdOffsetMin: 60,
  },
  BHX: {
    icao: 'EGBB',
    name: 'Birmingham Airport',
    city: 'Birmingham',
    lat: 52.4539,
    lon: -1.74803,
    country: 'GB',
    utcStdOffsetMin: 0,
  },
  LBA: {
    icao: 'EGNM',
    name: 'Leeds Bradford Airport',
    city: 'Leeds Bradford',
    lat: 53.8659,
    lon: -1.66057,
    country: 'GB',
    utcStdOffsetMin: 0,
  },
  NCL: {
    icao: 'EGNT',
    name: 'Newcastle International Airport',
    city: 'Newcastle',
    lat: 55.03796,
    lon: -1.68958,
    country: 'GB',
    utcStdOffsetMin: 0,
  },
  GLA: {
    icao: 'EGPF',
    name: 'Glasgow Airport',
    city: 'Glasgow',
    lat: 55.8719,
    lon: -4.43306,
    country: 'GB',
    utcStdOffsetMin: 0,
  },
  BRS: {
    icao: 'EGGD',
    name: 'Bristol Airport',
    city: 'Bristol',
    lat: 51.38233,
    lon: -2.71645,
    country: 'GB',
    utcStdOffsetMin: 0,
  },
  SNN: {
    icao: 'EINN',
    name: 'Shannon Airport',
    city: 'Shannon',
    lat: 52.702,
    lon: -8.92482,
    country: 'IE',
    utcStdOffsetMin: 0,
  },
  JER: {
    icao: 'EGJJ',
    name: 'Jersey Airport',
    city: 'Jersey',
    lat: 49.2079,
    lon: -2.19551,
    country: 'JE',
    utcStdOffsetMin: 0,
  },
};

export const MAIN_BASE = 'MAN';
export const BASES = ['MAN', 'LGW', 'EDI'] as const;
export type BaseIata = (typeof BASES)[number];

/** Scheduled destinations per base (the fictional route map). */
export const ROUTES: Record<BaseIata, readonly string[]> = {
  MAN: [
    'PMI',
    'AGP',
    'ALC',
    'FAO',
    'TFS',
    'LPA',
    'IBZ',
    'BCN',
    'DUB',
    'AMS',
    'CDG',
    'GVA',
    'NCE',
    'LIS',
    'FCO',
    'PRG',
    'BFS',
    'KRK',
  ],
  LGW: ['PMI', 'AGP', 'FAO', 'TFS', 'BCN', 'AMS', 'NCE', 'LIS', 'FCO', 'GVA', 'PRG', 'OPO', 'IBZ'],
  EDI: ['PMI', 'AGP', 'ALC', 'DUB', 'AMS', 'CDG', 'BCN', 'FAO', 'KRK'],
};

const SERVED = new Set<string>(Object.values(ROUTES).flat());

function roleOf(iata: string): StationRole {
  if (iata === MAIN_BASE) return 'main_base';
  if ((BASES as readonly string[]).includes(iata)) return 'base';
  return SERVED.has(iata) ? 'outstation' : 'alternate';
}

export const NETWORK_STATIONS: readonly NetworkStation[] = Object.entries(RAW).map(([iata, r]) => ({
  iata,
  ...r,
  role: roleOf(iata),
}));

const BY_IATA = new Map(NETWORK_STATIONS.map((s) => [s.iata, s]));

export function stationByIata(iata: string): NetworkStation | undefined {
  return BY_IATA.get(iata);
}

export function isBase(iata: string): boolean {
  return (BASES as readonly string[]).includes(iata);
}

/** Rounded public runway lengths (m) and RFFS categories; illustrative only. */
const RUNWAY_RFFS: Record<string, [number, number]> = {
  MAN: [3050, 9],
  LGW: [3320, 9],
  EDI: [2560, 8],
  PMI: [3270, 9],
  AGP: [3200, 9],
  ALC: [3000, 8],
  FAO: [2490, 8],
  TFS: [3200, 8],
  LPA: [3100, 9],
  IBZ: [2800, 7],
  BCN: [3350, 9],
  DUB: [3110, 9],
  AMS: [3800, 10],
  CDG: [4200, 10],
  GVA: [3900, 9],
  NCE: [2960, 9],
  LIS: [3700, 9],
  OPO: [3480, 8],
  FCO: [3900, 10],
  PRG: [3700, 9],
  BFS: [2780, 7],
  KRK: [2550, 8],
  CPH: [3600, 9],
  VIE: [3600, 9],
  BOD: [3100, 8],
  NTE: [2900, 7],
  BIO: [2600, 7],
  SCQ: [3200, 7],
  LYS: [4000, 9],
  MRS: [3500, 8],
  VLC: [3200, 8],
  SVQ: [3360, 8],
  MAD: [4350, 10],
  ORY: [3650, 9],
  BHX: [3050, 9],
  LBA: [2250, 7],
  NCL: [2330, 7],
  GLA: [2660, 8],
  BRS: [2010, 7],
  SNN: [3200, 9],
  JER: [1710, 6],
};

/** Fictional limited opening hours (the rest are treated as 24 h for the simulation). */
const OPEN_HOURS: Record<string, string> = { JER: '06:00–22:30', SCQ: '06:00–23:30', LBA: '06:00–23:30' };

function fictionalRooms(iata: string, role: StationRole): number {
  let h = 0;
  for (const c of iata) h = (h * 31 + c.charCodeAt(0)) % 997;
  const base = role === 'main_base' ? 400 : role === 'base' ? 260 : role === 'outstation' ? 180 : 90;
  return base + (h % 60);
}

export const AIRPORT_CAPABILITIES: readonly AirportCapability[] = NETWORK_STATIONS.map((s) => {
  const [runwayM, rffsCat] = RUNWAY_RFFS[s.iata] ?? [2500, 7];
  const cap: AirportCapability = {
    iata: s.iata,
    runwayM,
    rffsCat,
    handlingContract: s.role !== 'alternate' || ['BHX', 'GLA', 'BOD', 'LYS', 'MAD'].includes(s.iata),
    engineering:
      s.role === 'main_base' || s.role === 'base'
        ? 'own'
        : ['PMI', 'AGP', 'TFS', 'DUB', 'AMS', 'ALC'].includes(s.iata)
          ? 'contract'
          : 'none',
    customs: true,
    hotelRooms: fictionalRooms(s.iata, s.role),
    openHours: OPEN_HOURS[s.iata] ?? '24h',
    fictional: ['handlingContract', 'engineering', 'hotelRooms', 'curfew', 'openHours'],
  };
  if (s.iata === 'LGW') cap.curfew = { fromLocal: '23:30', toLocal: '06:00' };
  if (s.iata === 'FCO' || s.iata === 'GVA') cap.curfew = { fromLocal: '00:00', toLocal: '06:00' };
  return cap;
});

const CAP_BY_IATA = new Map(AIRPORT_CAPABILITIES.map((c) => [c.iata, c]));

export function capabilityOf(iata: string): AirportCapability | undefined {
  return CAP_BY_IATA.get(iata);
}

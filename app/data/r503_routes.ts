export type RouteVariantId = 'r503_am' | 'r503_pm';
export type LegDirection = 'outbound' | 'return';

export interface CanonicalRouteStop {
  stopId: string;
  loopStopSequenceIndex: number;
  name: string;
  lat: number;
  lng: number;
  headingDeg: number | null;
}

export interface RouteVariantDefinition {
  variantId: RouteVariantId;
  timePeriod: 'AM' | 'PM';
  startTime: string;
  endTime: string;
  roundTripsPerSession: number;
  outboundStartIndex: number;
  returnStartIndex: number;
  canonicalStops: CanonicalRouteStop[];
}

const AM_STOPS: CanonicalRouteStop[] = [
  { stopId: 'r503_am_s01', loopStopSequenceIndex: 0, name: 'Hope Avenue Bangkal Station', lat: 7.060941181744724, lng: 125.55389545175399, headingDeg: 104.2 },
  { stopId: 'r503_am_s02', loopStopSequenceIndex: 1, name: 'Ateneo Senior High Station', lat: 7.060700779168272, lng: 125.5567978228379, headingDeg: 72.5 },
  { stopId: 'r503_am_s03', loopStopSequenceIndex: 2, name: 'SPED Bangkal Station', lat: 7.061255258672034, lng: 125.55956428731429, headingDeg: 76.8 },
  { stopId: 'r503_am_s04', loopStopSequenceIndex: 3, name: 'Tahimik Avenue Matina Station', lat: 7.060840717374191, lng: 125.56367702832335, headingDeg: 110.4 },
  { stopId: 'r503_am_s05', loopStopSequenceIndex: 4, name: 'Matina Crossing Station', lat: 7.058172424027731, lng: 125.56975900724251, headingDeg: 110.2 },
  { stopId: 'r503_am_s06', loopStopSequenceIndex: 5, name: 'Kawayan Drive Station', lat: 7.055763967087287, lng: 125.57540976367454, headingDeg: 96.2 },
  { stopId: 'r503_am_s07', loopStopSequenceIndex: 6, name: 'DGT Station', lat: 7.058288463021384, lng: 125.58031629926563, headingDeg: 53.1 },
  { stopId: 'r503_am_s08', loopStopSequenceIndex: 7, name: 'Water District Matina Station', lat: 7.060972585362123, lng: 125.59005429145282, headingDeg: 73.9 },
  { stopId: 'r503_am_s09', loopStopSequenceIndex: 8, name: 'NCCC Maa Station', lat: 7.06192856978879, lng: 125.59391312759931, headingDeg: 75.7 },
  { stopId: 'r503_am_s10', loopStopSequenceIndex: 9, name: 'Ateneo Matina Station', lat: 7.062850789005836, lng: 125.59773797305172, headingDeg: 75.9 },
  { stopId: 'r503_am_s11', loopStopSequenceIndex: 10, name: 'Pichon Street corner Quirino Avenue Station', lat: 7.067860141373998, lng: 125.60311746328352, headingDeg: 129.5 },
  { stopId: 'r503_am_s12', loopStopSequenceIndex: 11, name: 'Grand Menseng Hotel Station', lat: 7.0645041532673645, lng: 125.60685088783407, headingDeg: 118.2 },
  { stopId: 'r503_am_s13', loopStopSequenceIndex: 12, name: 'CM Recto Avenue Station', lat: 7.0665252644676, lng: 125.61056370265396, headingDeg: 13.4 },
  { stopId: 'r503_am_s14', loopStopSequenceIndex: 13, name: 'Davao Light (C. Bangoy Street) Station', lat: 7.072765836687623, lng: 125.61067755688578, headingDeg: 192.4 },
  { stopId: 'r503_am_s15', loopStopSequenceIndex: 14, name: 'San Pedro Street Station', lat: 7.0656784289, lng: 125.6077419157059, headingDeg: 306.2 },
  { stopId: 'r503_am_s16', loopStopSequenceIndex: 15, name: 'UM Matina Station', lat: 7.063223650419204, lng: 125.59864732887877, headingDeg: 255.1 },
  { stopId: 'r503_am_s17', loopStopSequenceIndex: 16, name: 'Alorica Davao Station', lat: 7.0615768829222105, lng: 125.59156268959782, headingDeg: 253.4 },
  { stopId: 'r503_am_s18', loopStopSequenceIndex: 17, name: 'Shrine Hills Matina Station', lat: 7.05778664920966, lng: 125.57937306976874, headingDeg: 228.0 },
  { stopId: 'r503_am_s19', loopStopSequenceIndex: 18, name: 'Kawayan Drive Station', lat: 7.055741148671061, lng: 125.57639590916756, headingDeg: 284.0 },
  { stopId: 'r503_am_s20', loopStopSequenceIndex: 19, name: 'Matina Crossing Station', lat: 7.059119694383455, lng: 125.56804719424792, headingDeg: 290.7 },
  { stopId: 'r503_am_s21', loopStopSequenceIndex: 20, name: 'Tahimik Avenue Matina Station', lat: 7.0609816636522, lng: 125.5637230487032, headingDeg: 290.9 },
  { stopId: 'r503_am_s22', loopStopSequenceIndex: 21, name: 'SPED Bangkal Station', lat: 7.061422488598026, lng: 125.55969857564492, headingDeg: 258.4 },
  { stopId: 'r503_am_s23', loopStopSequenceIndex: 22, name: 'Shell Bangkal Station', lat: 7.060689319708203, lng: 125.55521061655963, headingDeg: 257.3 },
  { stopId: 'r503_am_s24', loopStopSequenceIndex: 23, name: 'Hope Avenue Bangkal Station', lat: 7.060941181744724, lng: 125.55389545175399, headingDeg: 0 },
];

const PM_STOPS: CanonicalRouteStop[] = [
  { stopId: 'r503_pm_s01', loopStopSequenceIndex: 0, name: 'Davao Light (C. Bangoy Street) Station', lat: 7.072765836687623, lng: 125.61067755688578, headingDeg: 192.4 },
  { stopId: 'r503_pm_s02', loopStopSequenceIndex: 1, name: 'San Pedro Street Station', lat: 7.0656784289, lng: 125.6077419157059, headingDeg: 306.2 },
  { stopId: 'r503_pm_s03', loopStopSequenceIndex: 2, name: 'UM Matina Station', lat: 7.063223650419204, lng: 125.59864732887877, headingDeg: 255.1 },
  { stopId: 'r503_pm_s04', loopStopSequenceIndex: 3, name: 'Alorica Davao Station', lat: 7.0615768829222105, lng: 125.59156268959782, headingDeg: 253.4 },
  { stopId: 'r503_pm_s05', loopStopSequenceIndex: 4, name: 'Shrine Hills Matina Station', lat: 7.05778664920966, lng: 125.57937306976874, headingDeg: 228.0 },
  { stopId: 'r503_pm_s06', loopStopSequenceIndex: 5, name: 'Kawayan Drive Station', lat: 7.055741148671061, lng: 125.57639590916756, headingDeg: 284.0 },
  { stopId: 'r503_pm_s07', loopStopSequenceIndex: 6, name: 'Matina Crossing Station', lat: 7.059119694383455, lng: 125.56804719424792, headingDeg: 290.7 },
  { stopId: 'r503_pm_s08', loopStopSequenceIndex: 7, name: 'Tahimik Avenue Matina Station', lat: 7.0609816636522, lng: 125.5637230487032, headingDeg: 290.9 },
  { stopId: 'r503_pm_s09', loopStopSequenceIndex: 8, name: 'SPED Bangkal Station', lat: 7.061422488598026, lng: 125.55969857564492, headingDeg: 258.4 },
  { stopId: 'r503_pm_s10', loopStopSequenceIndex: 9, name: 'Shell Bangkal Station', lat: 7.060689319708203, lng: 125.55521061655963, headingDeg: 257.3 },
  { stopId: 'r503_pm_s11', loopStopSequenceIndex: 10, name: 'Hope Avenue Bangkal Station', lat: 7.060941181744724, lng: 125.55389545175399, headingDeg: 104.2 },
  { stopId: 'r503_pm_s12', loopStopSequenceIndex: 11, name: 'Ateneo Senior High Station', lat: 7.060700779168272, lng: 125.5567978228379, headingDeg: 72.5 },
  { stopId: 'r503_pm_s13', loopStopSequenceIndex: 12, name: 'SPED Bangkal Station', lat: 7.061255258672034, lng: 125.55956428731429, headingDeg: 76.8 },
  { stopId: 'r503_pm_s14', loopStopSequenceIndex: 13, name: 'Tahimik Avenue Matina Station', lat: 7.060840717374191, lng: 125.56367702832335, headingDeg: 110.4 },
  { stopId: 'r503_pm_s15', loopStopSequenceIndex: 14, name: 'Matina Crossing Station', lat: 7.058172424027731, lng: 125.56975900724251, headingDeg: 110.2 },
  { stopId: 'r503_pm_s16', loopStopSequenceIndex: 15, name: 'Kawayan Drive Station', lat: 7.055763967087287, lng: 125.57540976367454, headingDeg: 96.2 },
  { stopId: 'r503_pm_s17', loopStopSequenceIndex: 16, name: 'DGT Station', lat: 7.058288463021384, lng: 125.58031629926563, headingDeg: 53.1 },
  { stopId: 'r503_pm_s18', loopStopSequenceIndex: 17, name: 'Water District Matina Station', lat: 7.060972585362123, lng: 125.59005429145282, headingDeg: 73.9 },
  { stopId: 'r503_pm_s19', loopStopSequenceIndex: 18, name: 'NCCC Maa Station', lat: 7.06192856978879, lng: 125.59391312759931, headingDeg: 75.7 },
  { stopId: 'r503_pm_s20', loopStopSequenceIndex: 19, name: 'Ateneo Matina Station', lat: 7.062850789005836, lng: 125.59773797305172, headingDeg: 75.9 },
  { stopId: 'r503_pm_s21', loopStopSequenceIndex: 20, name: 'Pichon Street corner Quirino Avenue Station', lat: 7.067860141373998, lng: 125.60311746328352, headingDeg: 129.5 },
  { stopId: 'r503_pm_s22', loopStopSequenceIndex: 21, name: 'Grand Menseng Hotel Station', lat: 7.0645041532673645, lng: 125.60685088783407, headingDeg: 118.2 },
  { stopId: 'r503_pm_s23', loopStopSequenceIndex: 22, name: 'CM Recto Avenue Station', lat: 7.0665252644676, lng: 125.61056370265396, headingDeg: 13.4 },
  { stopId: 'r503_pm_s24', loopStopSequenceIndex: 23, name: 'Davao Light (C. Bangoy Street) Station', lat: 7.072765836687623, lng: 125.61067755688578, headingDeg: 0 },
];

export const R503_ROUTE_VARIANTS: RouteVariantDefinition[] = [
  {
    variantId: 'r503_am',
    timePeriod: 'AM',
    startTime: '06:00',
    endTime: '10:00',
    roundTripsPerSession: 2,
    outboundStartIndex: 0,
    returnStartIndex: 14,
    canonicalStops: AM_STOPS,
  },
  {
    variantId: 'r503_pm',
    timePeriod: 'PM',
    startTime: '16:00',
    endTime: '21:00',
    roundTripsPerSession: 3,
    outboundStartIndex: 10,
    returnStartIndex: 0,
    canonicalStops: PM_STOPS,
  },
];

export function getRouteVariantDefinition(variantId: RouteVariantId): RouteVariantDefinition {
  const variant = R503_ROUTE_VARIANTS.find((item) => item.variantId === variantId);
  if (!variant) {
    throw new Error(`Unknown route variant: ${variantId}`);
  }
  return variant;
}

export function detectRouteVariantAt(timestampMs: number): RouteVariantDefinition {
  const date = new Date(timestampMs);
  const minutes = date.getHours() * 60 + date.getMinutes();
  for (const variant of R503_ROUTE_VARIANTS) {
    const [startHour, startMinute] = variant.startTime.split(':').map(Number);
    const [endHour, endMinute] = variant.endTime.split(':').map(Number);
    const start = startHour * 60 + startMinute;
    const end = endHour * 60 + endMinute;
    if (minutes >= start && minutes < end) {
      return variant;
    }
  }
  return minutes < 13 * 60 + 30 ? getRouteVariantDefinition('r503_am') : getRouteVariantDefinition('r503_pm');
}

export function getLegDirectionForLoopIndex(variantId: RouteVariantId, loopStopSequenceIndex: number): LegDirection {
  const variant = getRouteVariantDefinition(variantId);
  const normalized = normalizeLoopIndex(loopStopSequenceIndex, variant.canonicalStops.length);
  if (variant.outboundStartIndex <= variant.returnStartIndex) {
    return normalized >= variant.outboundStartIndex && normalized < variant.returnStartIndex ? 'outbound' : 'return';
  }
  return normalized >= variant.outboundStartIndex || normalized < variant.returnStartIndex ? 'outbound' : 'return';
}

export function normalizeLoopIndex(loopStopSequenceIndex: number, stopCount: number): number {
  if (stopCount <= 0) {
    return 0;
  }
  return ((loopStopSequenceIndex % stopCount) + stopCount) % stopCount;
}

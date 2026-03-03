import type { DirectionCode } from '../models/Trip';

export interface R503StopSeed {
  stop_id: number;
  stop_name: string;
  lat: number;
  lon: number;
  stop_sequence: number;
  direction_code: DirectionCode;
}

export const R503_STOPS: R503StopSeed[] = [
  {
    stop_id: 1,
    stop_name: 'Hope Avenue Bangkal Station',
    lat: 7.060941181744724,
    lon: 125.55389545175399,
    stop_sequence: 1,
    direction_code: 'A',
  },
  {
    stop_id: 2,
    stop_name: 'Ateneo Senior High Station',
    lat: 7.060700779168272,
    lon: 125.5567978228379,
    stop_sequence: 2,
    direction_code: 'A',
  },
  {
    stop_id: 3,
    stop_name: 'SPED Bangkal Station',
    lat: 7.061255258672034,
    lon: 125.55956428731429,
    stop_sequence: 3,
    direction_code: 'A',
  },
  {
    stop_id: 4,
    stop_name: 'Tahimik Avenue Matina Station',
    lat: 7.060840717374191,
    lon: 125.56367702832335,
    stop_sequence: 4,
    direction_code: 'A',
  },
  {
    stop_id: 5,
    stop_name: 'Matina Crossing Station',
    lat: 7.058172424027731,
    lon: 125.56975900724251,
    stop_sequence: 5,
    direction_code: 'A',
  },
  {
    stop_id: 6,
    stop_name: 'Kawayan Drive Station',
    lat: 7.055763967087287,
    lon: 125.57540976367454,
    stop_sequence: 6,
    direction_code: 'A',
  },
  {
    stop_id: 7,
    stop_name: 'DGT Station',
    lat: 7.058288463021384,
    lon: 125.58031629926563,
    stop_sequence: 7,
    direction_code: 'A',
  },
  {
    stop_id: 8,
    stop_name: 'Water District Matina Station',
    lat: 7.060972585362123,
    lon: 125.59005429145282,
    stop_sequence: 8,
    direction_code: 'A',
  },
  {
    stop_id: 9,
    stop_name: 'NCCC Maa Station',
    lat: 7.06192856978879,
    lon: 125.59391312759931,
    stop_sequence: 9,
    direction_code: 'A',
  },
  {
    stop_id: 10,
    stop_name: 'Ateneo Matina Station',
    lat: 7.062850789005836,
    lon: 125.59773797305172,
    stop_sequence: 10,
    direction_code: 'A',
  },
  {
    stop_id: 11,
    stop_name: 'Pichon St corner Quirino Ave Station',
    lat: 7.067860141373998,
    lon: 125.60311746328352,
    stop_sequence: 11,
    direction_code: 'A',
  },
  {
    stop_id: 12,
    stop_name: 'Grand Menseng Hotel Station',
    lat: 7.0645041532673645,
    lon: 125.60685088783407,
    stop_sequence: 12,
    direction_code: 'A',
  },
  {
    stop_id: 13,
    stop_name: 'CM Recto Avenue Station',
    lat: 7.0665252644676,
    lon: 125.61056370265396,
    stop_sequence: 13,
    direction_code: 'A',
  },
  {
    stop_id: 14,
    stop_name: 'Davao Light (C. Bangoy Street) Station',
    lat: 7.072765836687623,
    lon: 125.61067755688578,
    stop_sequence: 14,
    direction_code: 'A',
  },
];

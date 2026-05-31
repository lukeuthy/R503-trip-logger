export interface R503StopSeed {
  stop_id: number;
  stop_name: string;
  lat: number;
  lon: number;
  stop_sequence: number;
}

// 23-stop loop. Sequences 1–14 are the outbound leg (Hope Avenue → Davao Light).
// Sequences 15–23 are the return leg on a different road (San Pedro St → Shell Bangkal).
// The loop closes back at stop 1 (Hope Avenue) — it is NOT duplicated as stop 24.
//
// AM sessions start at stop 1; PM sessions start at stop 14.
// Both time periods traverse the same 23 physical locations; AM/PM is a time-bucket
// label only and does not affect which stops are detected.
//
// Several stop names repeat (e.g. "Kawayan Drive Station", "Matina Crossing Station")
// because the outbound and return roads have physically distinct stop pads at those
// locations. The different lat/lng values are what distinguish them — not the name.
export const R503_STOPS: R503StopSeed[] = [
  { stop_id: 1,  stop_name: 'Hope Avenue Bangkal Station',                   lat: 7.060941181744724,  lon: 125.55389545175399, stop_sequence: 1  },
  { stop_id: 2,  stop_name: 'Ateneo Senior High Station',                    lat: 7.060700779168272,  lon: 125.5567978228379,  stop_sequence: 2  },
  { stop_id: 3,  stop_name: 'SPED Bangkal Station',                          lat: 7.061255258672034,  lon: 125.55956428731429, stop_sequence: 3  },
  { stop_id: 4,  stop_name: 'Tahimik Avenue Matina Station',                 lat: 7.060840717374191,  lon: 125.56367702832335, stop_sequence: 4  },
  { stop_id: 5,  stop_name: 'Matina Crossing Station',                       lat: 7.058172424027731,  lon: 125.56975900724251, stop_sequence: 5  },
  { stop_id: 6,  stop_name: 'Kawayan Drive Station',                         lat: 7.055763967087287,  lon: 125.57540976367454, stop_sequence: 6  },
  { stop_id: 7,  stop_name: 'DGT Station',                                   lat: 7.058288463021384,  lon: 125.58031629926563, stop_sequence: 7  },
  { stop_id: 8,  stop_name: 'Water District Matina Station',                 lat: 7.060972585362123,  lon: 125.59005429145282, stop_sequence: 8  },
  { stop_id: 9,  stop_name: 'NCCC Maa Station',                              lat: 7.06192856978879,   lon: 125.59391312759931, stop_sequence: 9  },
  { stop_id: 10, stop_name: 'Ateneo Matina Station',                         lat: 7.062850789005836,  lon: 125.59773797305172, stop_sequence: 10 },
  { stop_id: 11, stop_name: 'Pichon Street corner Quirino Avenue Station',   lat: 7.067860141373998,  lon: 125.60311746328352, stop_sequence: 11 },
  { stop_id: 12, stop_name: 'Grand Menseng Hotel Station',                   lat: 7.0645041532673645, lon: 125.60685088783407, stop_sequence: 12 },
  { stop_id: 13, stop_name: 'CM Recto Avenue Station',                       lat: 7.0665252644676,    lon: 125.61056370265396, stop_sequence: 13 },
  { stop_id: 14, stop_name: 'Davao Light (C. Bangoy Street) Station',        lat: 7.072765836687623,  lon: 125.61067755688578, stop_sequence: 14 },
  { stop_id: 15, stop_name: 'San Pedro Street Station',                      lat: 7.0656784289,        lon: 125.6077419157059,  stop_sequence: 15 },
  { stop_id: 16, stop_name: 'UM Matina Station',                             lat: 7.063223650419204,  lon: 125.59864732887877, stop_sequence: 16 },
  { stop_id: 17, stop_name: 'Alorica Davao Station',                         lat: 7.0615768829222105, lon: 125.59156268959782, stop_sequence: 17 },
  { stop_id: 18, stop_name: 'Shrine Hills Matina Station',                   lat: 7.05778664920966,   lon: 125.57937306976874, stop_sequence: 18 },
  { stop_id: 19, stop_name: 'Kawayan Drive Station',                         lat: 7.055741148671061,  lon: 125.57639590916756, stop_sequence: 19 },
  { stop_id: 20, stop_name: 'Matina Crossing Station',                       lat: 7.059119694383455,  lon: 125.56804719424792, stop_sequence: 20 },
  { stop_id: 21, stop_name: 'Tahimik Avenue Matina Station',                 lat: 7.0609816636522,    lon: 125.5637230487032,  stop_sequence: 21 },
  { stop_id: 22, stop_name: 'SPED Bangkal Station',                          lat: 7.061422488598026,  lon: 125.55969857564492, stop_sequence: 22 },
  { stop_id: 23, stop_name: 'Shell Bangkal Station',                         lat: 7.060689319708203,  lon: 125.55521061655963, stop_sequence: 23 },
];

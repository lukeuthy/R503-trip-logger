import type { DirectionCode } from './Trip';

export interface StopRow {
  stop_id: number;
  stop_name: string;
  lat: number;
  lon: number;
  stop_sequence: number;
  direction_code: DirectionCode;
}

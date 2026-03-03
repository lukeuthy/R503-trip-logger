export type DirectionCode = 'A' | 'B';
export type WindowCode = 'AM' | 'PM' | 'OFF';

export interface TripRow {
  trip_id: string;
  started_at_ms: number;
  ended_at_ms: number | null;
  route_number: string;
  direction_code: DirectionCode;
  window_code: WindowCode;
  status: string;
}

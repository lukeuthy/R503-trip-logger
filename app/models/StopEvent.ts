export type StopEventType = 'ENTER' | 'EXIT' | 'DWELL_CONFIRMED';

export interface StopEventRow {
  id: number;
  trip_id: string;
  stop_id: number;
  event_type: StopEventType;
  timestamp_ms: number;
  dist_m: number;
  lat: number | null;
  lon: number | null;
}

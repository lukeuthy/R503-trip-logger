export interface GPSPointRow {
  id: number;
  trip_id: string;
  timestamp_ms: number;
  lat: number;
  lon: number;
  accuracy_m: number | null;
  speed_mps: number | null;
  heading_deg: number | null;
}

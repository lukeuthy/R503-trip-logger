import { applyEmaSmoothing, filterRawPoint, haversineMeters } from '../filters';

describe('filters', () => {
  it('computes haversine distance', () => {
    const distance = haversineMeters(7.0609, 125.5538, 7.0619, 125.5538);
    expect(distance).toBeGreaterThan(100);
  });

  it('flags teleport jumps', () => {
    const result = filterRawPoint(
      { timestampMs: 1000, lat: 7.0, lon: 125.0, accuracyM: 5, speedMps: 3 },
      { timestampMs: 2000, lat: 7.5, lon: 125.5, accuracyM: 5, speedMps: 3 },
    );
    expect(result.isFiltered).toBe(true);
    expect(result.reason).toBe('teleport-jump');
  });

  it('applies ema smoothing', () => {
    const smooth = applyEmaSmoothing({ lat: 7, lon: 125, speedMps: 4 }, { lat: 8, lon: 126, speedMps: 6 }, 0.25);
    expect(smooth.lat).toBeCloseTo(7.25);
    expect(smooth.lon).toBeCloseTo(125.25);
  });
});

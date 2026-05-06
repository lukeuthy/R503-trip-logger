import { createInitialStopDetectionState, evaluateSequencedStopDetection } from '../stopDetector';

describe('stop detector', () => {
  const stops = [
    { stopId: 's1', stopOrder: 1, name: 'S1', lat: 7, lng: 125, radiusM: 40 },
    { stopId: 's2', stopOrder: 2, name: 'S2', lat: 7.001, lng: 125.001, radiusM: 40 },
  ];

  it('emits arrive then depart', () => {
    const initial = createInitialStopDetectionState();
    const arrive = evaluateSequencedStopDetection(
      initial,
      stops,
      { timestampMs: 0, lat: 7, lon: 125, speedMps: 1, accuracyM: 5 },
      undefined,
    );
    expect(arrive.events.some((event) => event.eventType === 'arrive')).toBe(true);

    const depart = evaluateSequencedStopDetection(
      arrive.nextState,
      stops,
      { timestampMs: 7000, lat: 7.002, lon: 125.002, speedMps: 6, accuracyM: 5 },
      undefined,
    );
    expect(depart.events.some((event) => event.eventType === 'depart')).toBe(true);
  });
});

import { useEffect, useState } from 'react';

import { tripController, type UITripState } from '../../trip/TripController';

export function useTripState(): UITripState {
  const [state, setState] = useState<UITripState>(tripController.getState());
  useEffect(() => tripController.subscribe(setState), []);
  return state;
}

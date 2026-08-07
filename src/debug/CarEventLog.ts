export interface CarEvent {
  time: number;
  carId: string;
  type: string;
  message: string;
  data?: Record<string, unknown>;
}

const MAX_EVENTS = 500;

class CarEventLogImpl {
  private events: CarEvent[] = [];
  private carIds = new Set<string>();

  log(event: CarEvent): void {
    if (this.events.length >= MAX_EVENTS) {
      this.events.shift();
    }
    this.events.push(event);
    this.carIds.add(event.carId);
  }

  getEventsForCar(carId: string): CarEvent[] {
    return this.events.filter(e => e.carId === carId);
  }

  getAllCars(): Set<string> {
    return this.carIds;
  }

  getRecentEvents(n: number): CarEvent[] {
    return this.events.slice(-n);
  }

  clear(): void {
    this.events = [];
    this.carIds.clear();
  }
}

export const CarEventLog = new CarEventLogImpl();

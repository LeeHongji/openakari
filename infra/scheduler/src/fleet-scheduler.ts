/** Fleet scheduler stub — placeholder type for chat module compatibility.
 *  The full fleet scheduler is in the reference implementation. */

export interface FleetScheduler {
  isEnabled(): boolean;
  getActiveWorkers(): { id: string }[];
  getStatusSnapshot(): { maxWorkers: number };
  enable(size?: number): void;
  disable(): void;
  resize(size: number): void;
  updateConfig(config: { maxWorkers: number }): void;
}

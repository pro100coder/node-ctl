// The wire model. Every line of output anywhere in the UI is one of these events; the action it
// belongs to is fixed by action_id when the event is created, never guessed from text later.
export type EventType =
  | 'planned' // a step declared up front, shown as pending until it starts
  | 'started'
  | 'progress'
  | 'log'
  | 'warning'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type Stream = 'stdout' | 'stderr';

export interface ActionEvent {
  seq: number; // monotonic per producer: order inside an action survives any transport
  action_id: string;
  parent_action_id: string | null;
  action_name: string;
  key: string; // short label for the plain renderer, e.g. "build"
  index?: number; // [index/total_steps] when the parent declared a plan
  total_steps?: number;
  event_type: EventType;
  message?: string;
  current?: number;
  total?: number;
  timestamp: string; // ISO 8601
  duration_ms?: number; // completed | failed | cancelled
  stream?: Stream; // lines of a child process only
}

export interface Renderer {
  handle(event: ActionEvent): void;
  close(): void;
}

// Where a renderer writes: stderr, a file of events, a test's buffer. Writes are synchronous strings.
export interface Out {
  write(text: string): unknown;
}

/** Tracks image writes until their Markdown references have been inserted. */
export class PendingUploads {
  private operations = new Set<Promise<void>>();

  add(operation: Promise<void>) {
    this.operations.add(operation);
    // Install both handlers immediately, so a failed background upload never
    // produces an unhandled rejection while awaiting a later explicit flush.
    void operation.then(() => this.operations.delete(operation), () => this.operations.delete(operation));
  }

  get pending() { return this.operations.size > 0; }

  async drain() {
    // More images can be pasted while an earlier upload is completing.
    while (this.operations.size) await Promise.all([...this.operations]);
  }
}

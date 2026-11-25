export class TripError extends Error {
  code: 'NOT_FOUND' | 'CONFLICT'
  constructor(code: 'NOT_FOUND' | 'CONFLICT', detail: string) {
    super(detail)
    this.code = code
  }
}

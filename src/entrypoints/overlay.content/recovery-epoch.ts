/** A recovery reply may only affect the detection generation that requested it. */
export function makeRecoveryEpoch() {
  let value = 0
  return {
    current: (): number => value,
    advance: (): number => ++value,
    isCurrent: (epoch: number): boolean => epoch === value,
  }
}

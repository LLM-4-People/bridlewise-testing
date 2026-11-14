/**
 * jsdom has no layout engine. Tests that judge data, navigation or declared
 * geometry use this shared observer and make no measured-layout claim.
 * Real observer delivery and geometry belong to the browser suites.
 */
export class LayoutFreeResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

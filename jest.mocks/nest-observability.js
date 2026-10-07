const mockDecorator = () => (target) => target;

module.exports = {
  Trace: mockDecorator,
  createObservabilityModule: jest.fn(() => ({ module: {} })),
  ObservabilityModule: class {},
};

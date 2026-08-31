function bootstrap() {
  const runtime = window.GizmoAppRuntime;
  if (!runtime) {
    throw new Error("The shared app runtime did not load.");
  }
  runtime.readConfig();
  runtime.markReady();
}


try {
  bootstrap();
} catch (error) {
  window.GizmoAppRuntime?.showFatalError(error);
}

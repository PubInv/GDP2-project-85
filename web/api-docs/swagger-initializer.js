(() => {
  const origin = window.location.origin;
  window.SwaggerUIBundle({
    url: "/openapi.json",
    dom_id: "#swagger-ui",
    layout: "BaseLayout",
    presets: [window.SwaggerUIBundle.presets.apis],
    validatorUrl: null,
    queryConfigEnabled: false,
    persistAuthorization: false,
    withCredentials: false,
    supportedSubmitMethods: ["get", "post"],
    displayRequestDuration: true,
    defaultModelsExpandDepth: -1,
    requestInterceptor(request) {
      const url = new URL(request.url, origin);
      if (url.origin !== origin || url.username || url.password) {
        throw new Error("The API workbench only calls its own local server.");
      }
      request.credentials = "same-origin";
      return request;
    },
  });
})();

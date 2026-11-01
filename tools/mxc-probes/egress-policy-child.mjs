import http from "node:http";
import net from "node:net";
const config = JSON.parse(process.argv[2]);
function request(port, target) {
  return new Promise((resolve) => {
    const request = http.get({ hostname: "127.0.0.1", port, path: target,
      headers: { "Proxy-Authorization": config.forgedAuthorization, Connection: "close" } }, (response) => {
      response.resume(); response.once("end", () => resolve({ status: response.statusCode }));
    });
    request.setTimeout(config.deadline, () => request.destroy(new Error("Fixture request deadline")));
    request.once("error", (error) => resolve({ error: error.code ?? error.message }));
  });
}
function connect(host, port) {
  return new Promise((resolve) => {
    const socket = net.connect(port, host);
    socket.setTimeout(config.deadline, () => socket.destroy(new Error("Fixture connect deadline")));
    socket.once("connect", () => { socket.destroy(); resolve({ connected: true }); });
    socket.once("error", (error) => resolve({ connected: false, error: error.code ?? error.message }));
  });
}
const result = {
  ownAllowed: await request(config.ownPort, "http://allowed.example/fixture"),
  ownDenied: await request(config.ownPort, "http://denied.example/fixture"),
  otherListener: await connect("127.0.0.1", config.otherPort),
  unrelatedListener: await connect("127.0.0.1", config.unrelatedPort),
  directEgress: await connect(config.directHost, config.unrelatedPort),
};
process.stdout.write(JSON.stringify(result) + "\n");

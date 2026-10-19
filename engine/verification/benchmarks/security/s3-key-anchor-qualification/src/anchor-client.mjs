import net from "node:net";

export function anchorRequest(socketPath, request, timeoutMilliseconds = 5_000) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let response = "";
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    socket.setTimeout(timeoutMilliseconds, () => finish(new Error("anchor request timed out")));
    socket.once("error", (error) => finish(error));
    socket.on("data", (chunk) => {
      response += chunk.toString("utf8");
      if (response.length > 65_536) {
        finish(new Error("anchor response exceeded limit"));
        return;
      }
      const newline = response.indexOf("\n");
      if (newline === -1) return;
      try {
        finish(null, JSON.parse(response.slice(0, newline)));
      } catch (error) {
        finish(error);
      }
    });
    socket.once("connect", () => socket.end(`${JSON.stringify(request)}\n`));
  });
}

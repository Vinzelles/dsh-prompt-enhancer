// 访问控制行为测试(从 src/index.js 截取纯函数段执行)
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import test from "node:test";

const src = readFileSync(new URL("../src/index.js", import.meta.url), "utf8").replace(/\r\n/g, "\n"); // CRLF 归一:工作区文件行尾不锁定截取 marker

function slice(startMarker, endMarker) {
  const start = src.indexOf(startMarker);
  if (start < 0) throw new Error("marker not found: " + startMarker);
  const end = src.indexOf(endMarker, start);
  if (end < 0) throw new Error("end marker not found: " + endMarker);
  return src.slice(start, end);
}

const addressesConst = slice("const LOOPBACK_ADDRESSES", ";\n") + ";\n";
const guardFn = slice("function isLoopbackRequest", "\n}\n") + "\n}\n";
const sandbox = new Function(addressesConst + "\n" + guardFn + "\nreturn { isLoopbackRequest };")();
const { isLoopbackRequest } = sandbox;
const req = (address) => (address === undefined ? {} : { method: "POST", socket: { remoteAddress: address } });

test("accepts 127.0.0.1", () => assert.equal(isLoopbackRequest(req("127.0.0.1")), true));
test("accepts ::1", () => assert.equal(isLoopbackRequest(req("::1")), true));
test("accepts ::ffff:127.0.0.1 (IPv4-mapped loopback)", () => assert.equal(isLoopbackRequest(req("::ffff:127.0.0.1")), true));

test("rejects private LAN IPv4", () => assert.equal(isLoopbackRequest(req("192.168.1.100")), false));
test("rejects private LAN IPv4 (10.x)", () => assert.equal(isLoopbackRequest(req("10.0.0.5")), false));
test("rejects IPv4-mapped non-loopback", () => assert.equal(isLoopbackRequest(req("::ffff:10.0.0.5")), false));
test("rejects public address", () => assert.equal(isLoopbackRequest(req("8.8.8.8")), false));
test("rejects 127.0.0.2 (only .1 whitelisted, fail-closed)", () => assert.equal(isLoopbackRequest(req("127.0.0.2")), false));

test("rejects missing socket (fail-closed)", () => assert.equal(isLoopbackRequest({ method: "POST" }), false));
test("rejects null request", () => assert.equal(isLoopbackRequest(null), false));
test("rejects non-string remoteAddress", () => assert.equal(isLoopbackRequest({ socket: { remoteAddress: 12700001 } }), false));
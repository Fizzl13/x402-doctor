// WalletConnect's sign client as a global, served from this server and loaded only when the owner proves with the
// Concordium wallet app on a phone: /concordium-proof.html proposes a session (a QR code to scan, or a link that opens
// the app on the same phone), asks for the proof over it, and ends the session after.
// qrcode-generator draws the QR code here, so the session link (it holds the session's key) never leaves the page.
// Rebuild with `npm ci && npm run build` in this folder after a version bump.
import { SignClient } from "@walletconnect/sign-client";
import qrcode from "qrcode-generator";
window.WalletConnectSignClient = SignClient;
window.WalletConnectQr = (text) => {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true }))}`;
};

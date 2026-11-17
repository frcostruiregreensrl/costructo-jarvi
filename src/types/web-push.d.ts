// Tipi minimi per web-push 3.6.7 (il pacchetto non include i suoi tipi).
declare module "web-push" {
  export interface PushSubscription { endpoint: string; keys: { p256dh: string; auth: string } }
  export interface SendResult { statusCode: number; body: string; headers: Record<string, string> }
  export class WebPushError extends Error { statusCode: number; body: string }
  export function setVapidDetails(subject: string, publicKey: string, privateKey: string): void;
  export function sendNotification(subscription: PushSubscription, payload?: string, options?: { TTL?: number; urgency?: string }): Promise<SendResult>;
  export function generateVAPIDKeys(): { publicKey: string; privateKey: string };
  const webpush: {
    setVapidDetails: typeof setVapidDetails;
    sendNotification: typeof sendNotification;
    generateVAPIDKeys: typeof generateVAPIDKeys;
  };
  export default webpush;
}

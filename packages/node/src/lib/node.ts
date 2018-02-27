import {
  Adapter,
  Breadcrumb,
  Client,
  Context,
  Options,
  SentryEvent,
  User,
} from '@sentry/core';

declare function require(path: string): any;
const Raven = require('raven');
const sendRavenEvent = Raven.send;
const captureRavenBreadcrumb = Raven.captureBreadcrumb;

// tslint:disable-next-line:no-empty-interface
export interface NodeOptions extends Options {}

export class SentryNode implements Adapter {
  private capturing: boolean = false;
  private captured: any;

  constructor(private client: Client, public options: NodeOptions = {}) {}

  public install(): Promise<boolean> {
    Raven.config(this.client.dsn.toString(true), this.options).install();

    // Hook into Raven's internal event sending mechanism. This allows us to
    // intercept events generated by Raven in the same way as events created
    // via `SentryNode.captureException`. In both cases, we call
    // `Client.send` with the intercepted event, so that the client can
    // override the sending mechanism.
    Raven.send = this.interceptRavenSend.bind(this);

    // Hook into Raven's breadcrumb mechanism. This allows us to intercept
    // both breadcrumbs created internally by Raven and pass them to the
    // Client first, before actually capturing them.
    Raven.captureBreadcrumb = this.interceptRavenBreadcrumb.bind(this);

    return Promise.resolve(true);
  }

  public getRaven(): any {
    return Raven;
  }

  public captureException(exception: any): Promise<SentryEvent> {
    // We are being called by the Client. We must not send the exception here,
    // which is why we capture and return it. The Client will then call `send`.
    return this.capture(() => Raven.captureException(exception));
  }

  public captureMessage(message: string): Promise<SentryEvent> {
    // We are being called by the Client. We must not send the message here,
    // which is why we capture and return it. The Client will then call `send`.
    return this.capture(() => Raven.captureMessage(message));
  }

  public captureBreadcrumb(breadcrumb: Breadcrumb): Promise<Breadcrumb> {
    // We are being called by the Client. This means, the breadcrumb has been
    // processed already and we can pass it on to Raven.
    return this.capture(() => Raven.captureBreadcrumb(breadcrumb));
  }

  public send(event: SentryEvent): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      sendRavenEvent.call(Raven, event, (error: any) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }

  public wrap(fn: () => void, options: object): any {
    return Raven.wrap(options, fn);
  }

  public setOptions(options: NodeOptions): Promise<void> {
    Object.assign(this.options, options);
    Object.assign(Raven, this.options);
    return Promise.resolve();
  }

  public getContext(): Promise<Context> {
    return Promise.resolve(Raven.getContext());
  }

  public setContext(context: Context): Promise<void> {
    Raven.setContext(context);
    return Promise.resolve();
  }

  private interceptRavenSend(event: SentryEvent): void {
    if (this.capturing) {
      // This event was requested via `SentryNode.captureException` or
      // `SentryNode.captureMessage`. We capture it, which will return it to
      // the `Client`. The client will call its `send` method automatically.
      this.captured = event;
    } else {
      // This event was generated inside Raven in a wrapped function or
      // global exception hook. We have to manually pass it to `Client.send`.
      // The client will then run all callbacks and decide how to send this
      // event.
      this.client.send(event);
    }
  }

  private interceptRavenBreadcrumb(crumb: Breadcrumb): void {
    if (this.capturing) {
      // This breadcrumb is being captured explicitly by the Client. We use
      // Raven's internal mechanism to store it.
      captureRavenBreadcrumb.call(Raven, crumb);
      this.captured = crumb;
    } else {
      // The breadcrumb has been generated internally by Raven. We return `false`
      // to prevent Raven's default mechanism and pass it to the client instead.
      // The client can then run all callbacks and decide how to store the
      // breadcrumb. If SentryNode is in charge, the Client will call
      // `SentryNode.captureBreadcrumb` next, which will capture it (see
      // above).
      this.client.captureBreadcrumb(crumb);
    }
  }

  private capture<R>(callback: () => void): R {
    this.captured = undefined;
    this.capturing = true;
    callback();

    const captured = this.captured;
    this.captured = undefined;
    this.capturing = false;

    if (captured === undefined) {
      throw new Error('Could not capture.');
    }

    return captured as R;
  }
}

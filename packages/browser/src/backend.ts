import { Backend, DSN, Options, SentryError } from '@sentry/core';
import { SentryEvent, SentryResponse } from '@sentry/types';
import {
  isDOMError,
  isDOMException,
  isError,
  isErrorEvent,
  isPlainObject,
} from '@sentry/utils/is';
import { supportsFetch } from '@sentry/utils/supports';
import {
  eventFromStacktrace,
  getEventOptionsFromPlainObject,
  prepareFramesForEvent,
} from './parsers';
import { computeStackTrace } from './tracekit';
import { FetchTransport, XHRTransport } from './transports';

/**
 * Configuration options for the Sentry Browser SDK.
 * @see BrowserClient for more information.
 */
export interface BrowserOptions extends Options {
  /**
   * A pattern for error messages which should not be sent to Sentry. By
   * default, all errors will be sent.
   */
  ignoreErrors?: Array<string | RegExp>;

  /**
   * A pattern for error URLs which should not be sent to Sentry. To whitelist
   * certain errors instead, use {@link Options.whitelistUrls}. By default, all
   * errors will be sent.
   */
  ignoreUrls?: Array<string | RegExp>;

  /**
   * A pattern for error URLs which should exclusively be sent to Sentry. This
   * is the opposite of {@link Options.ignoreUrls}. By default, all errors will
   * be sent.
   */
  whitelistUrls?: Array<string | RegExp>;

  /**
   * Defines a list source code file paths. Only errors including these paths in
   * their stack traces will be sent to Sentry. By default, all errors will be
   * sent.
   */
  includePaths?: Array<string | RegExp>;
}

/** The Sentry Browser SDK Backend. */
export class BrowserBackend implements Backend {
  /** Creates a new browser backend instance. */
  public constructor(private readonly options: BrowserOptions = {}) {}

  /**
   * @inheritDoc
   */
  public install(): boolean {
    // We are only called by the client if the SDK is enabled and a valid DSN
    // has been configured. If no DSN is present, this indicates a programming
    // error.
    const dsn = this.options.dsn;
    if (!dsn) {
      throw new SentryError('Invariant exception: install() must not be called when disabled');
    }

    Raven.config(dsn, this.options);

    // We need to leave it here for now, as we are skipping `install` call,
    // due to integrations migration
    // TODO: Remove it once we fully migrate our code
    Raven._isRavenInstalled = true;
    Error.stackTraceLimit = Raven._globalOptions.stackTraceLimit;

    // Hook into Raven's breadcrumb mechanism. This allows us to intercept both
    // breadcrumbs created internally by Raven and pass them to the Client
    // first, before actually capturing them.
    Raven.setBreadcrumbCallback(breadcrumb => {
      addBreadcrumb(breadcrumb);
      return false;
    });

    Raven._sendProcessedPayload = captureEvent;

    return true;
  }

  /**
   * @inheritDoc
   */
  public async eventFromException(exception: any): Promise<SentryEvent> {
    if (isErrorEvent(exception) && exception.error) {
      // If it is an ErrorEvent with `error` property, extract it to get actual Error
      exception = exception.error; // tslint:disable-line:no-parameter-reassignment
    } else if (isDOMError(exception) || isDOMException(exception)) {
      // If it is a DOMError or DOMException (which are legacy APIs, but still supported in some browsers)
      // then we just extract the name and message, as they don't provide anything else
      // https://developer.mozilla.org/en-US/docs/Web/API/DOMError
      // https://developer.mozilla.org/en-US/docs/Web/API/DOMException
      const name =
        exception.name || (isDOMError(exception) ? 'DOMError' : 'DOMException');
      const message = exception.message
        ? `${name}: ${exception.message}`
        : name;

      return this.eventFromMessage(message);
    } else if (isError(exception)) {
      // we have a real Error object, do nothing
    } else if (isPlainObject(exception)) {
      // If it is plain Object, serialize it manually and extract options
      // This will allow us to group events based on top-level keys
      // which is much better than creating new group when any key/value change
      const options = getEventOptionsFromPlainObject(exception);
      exception = new Error(options.message); // tslint:disable-line:no-parameter-reassignment
    } else {
      // If none of previous checks were valid, then it means that
      // it's not a DOMError/DOMException
      // it's not a plain Object
      // it's not a valid ErrorEvent (one with an error property)
      // it's not an Error
      // So bail out and capture it as a simple message:
      return this.eventFromMessage(exception);
    }

    // TODO: Create `shouldDropEvent` method to gather all user-options

    const event = eventFromStacktrace(computeStackTrace(exception));

    return {
      ...event,
      exception: {
        ...event.exception,
        mechanism: {
          handled: true,
          type: 'generic',
        },
      },
    };
  }

  /**
   * @inheritDoc
   */
  public async eventFromMessage(message: string): Promise<SentryEvent> {
    message = String(message); // tslint:disable-line:no-parameter-reassignment

    // Generate a "synthetic" stack trace from this point.
    // NOTE: If you are a Sentry user, and you are seeing this stack frame, it is NOT indicative
    //       of a bug with Raven.js. Sentry generates synthetic traces either by configuration,
    //       or if it catches a thrown object without a "stack" property.
    // Neither DOMError or DOMException provide stacktrace and we most likely wont get it this way as well
    // but it's barely any overhead so we may at least try
    let syntheticException: Error;
    try {
      throw new Error(message);
    } catch (exception) {
      syntheticException = exception;
      // null exception name so `Error` isn't prefixed to msg
      (syntheticException as any).name = null; // tslint:disable-line:no-null-keyword
    }

    const stacktrace = computeStackTrace(syntheticException);
    const frames = prepareFramesForEvent(stacktrace.stack);

    return {
      fingerprint: [message],
      message,
      stacktrace: {
        frames,
      },
    };

    // TODO: Revisit ignoreUrl behavior

    // Since we know this is a synthetic trace, the top frame (this function call)
    // MUST be from Raven.js, so mark it for trimming
    // We add to the trim counter so that callers can choose to trim extra frames, such
    // as utility functions.

    // stack[0] is `throw new Error(msg)` call itself, we are interested in the frame that was just before that, stack[1]
    // let initialCall = Array.isArray(stack.stack) && stack.stack[1];

    // if stack[1] is `eventFromException`, it means that someone passed a string to it and we redirected that call
    // to be handled by `eventFromMessage`, thus `initialCall` is the 3rd one, not 2nd
    // initialCall => captureException(string) => captureMessage(string)
    // TODO: Verify if this is actually a correct name
    // if (initialCall && initialCall.func === 'eventFromException') {
    //   initialCall = stack.stack[2];
    // }

    // const fileurl = (initialCall && initialCall.url) || '';

    // TODO: Create `shouldDropEvent` method to gather all user-options
  }

  /**
   * @inheritDoc
   */
  public async sendEvent(event: SentryEvent): Promise<SentryResponse> {
    let dsn: DSN;

    if (!this.options.dsn) {
      throw new SentryError('Cannot sendEvent without a valid DSN');
    } else {
      dsn = new DSN(this.options.dsn);
    }

    const transportOptions = this.options.transportOptions ? this.options.transportOptions : { dsn };

    const transport = this.options.transport
      ? new this.options.transport({ dsn })
      : supportsFetch()
        ? new FetchTransport(transportOptions)
        : new XHRTransport(transportOptions);

    return transport.send(event);
  }

  /**
   * @inheritDoc
   */
  public storeBreadcrumb(): boolean {
    return true;
  }

  /**
   * @inheritDoc
   */
  public storeScope(): void {
    // Noop
  }
}

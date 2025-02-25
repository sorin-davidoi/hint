import { ApplicationInsights } from '@microsoft/applicationinsights-web-basic';

import { Config, ErrorData, Results } from '../../shared/types';

import { determineHintStatus } from './hints';
import * as storage from './storage';

const manifest = require('../../manifest.json');
const storageKey = 'webhint-telemetry';
const alreadyOptInKey = 'webhint-already-opt-in';

const instrumentationKey = '8ef2b55b-2ce9-4c33-a09a-2c3ef605c97d';

let appInsights: ApplicationInsights | null = null;

const trackEvent = (name: string, properties: { [key: string]: string } = {}, measurements?: { [key: string]: number }) => {
    if (!appInsights) {
        return;
    }

    properties['extension-version'] = manifest.version;

    appInsights.track({
        baseData: {
            measurements,
            name,
            properties
        },
        baseType: 'EventData',
        name: `Microsoft.ApplicationInsights.${instrumentationKey}.Event`
    });
};

/**
 * Return true if the user has not respond yet
 * to opt-in.
 */
export const showOptIn = (s = storage) => {
    return s.getItem(storageKey) === undefined;
};

/** Called to initialize the underlying analytics library. */
export const setup = (s = storage) => {
    const telemetry = s.getItem(storageKey);

    if (!telemetry) {
        console.log('telemetry disabled');
        appInsights = null;

        return;
    }

    console.log('telemetry enabled');

    appInsights = new ApplicationInsights({ instrumentationKey });
};

/** Check if telemetry is enabled */
export const enabled = (s = storage) => {
    return !!s.getItem(storageKey);
};

/** Enables telemetry */
export const enable = (s = storage) => {
    s.setItem(storageKey, true);

    setup(s);

    // If it is the first time the user enable telemetry
    if (!s.getItem(alreadyOptInKey)) {
        s.setItem(alreadyOptInKey, true);
        trackEvent('f12-telemetry');
    }
};

/** Disables telemetry */
export const disable = (s = storage) => {
    s.setItem(storageKey, false);

    setup(s);
};

/** Called when analysis was canceled by the user. */
export const trackCancel = (duration: number) => {
    trackEvent('f12-cancel', undefined, { 'f12-cancel-duration': duration });
};

/** Called when analysis fails due to an error. */
export const trackError = (error: ErrorData) => {
    // Drop the error stack as it can contain filesystem paths.
    trackEvent('f12-error', { message: error.message });
};

/** Called when analysis finished. */
export const trackFinish = (config: Config, results: Results, duration: number) => {
    // Extract hint status from config and results, discarding user-provided data.
    const properties = determineHintStatus(config, results);

    trackEvent('f12-finish', properties, { 'f12-finish-duration': duration });
};

/** Called when the "Hints" tab was opened by the user. */
export const trackShow = () => {
    trackEvent('f12-show');
};

/** Called when analysis was started by the user. */
export const trackStart = () => {
    trackEvent('f12-start');
};

/** Called when analysis fails to complete in the allotted time. */
export const trackTimeout = (duration: number) => {
    trackEvent('f12-timeout', undefined, { 'f12-timeout-duration': duration });
};

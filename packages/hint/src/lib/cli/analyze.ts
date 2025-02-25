import * as path from 'path';

import boxen = require('boxen');
import * as chalk from 'chalk';
import * as isCI from 'is-ci';
import { default as ora } from 'ora';
import * as osLocale from 'os-locale';

import { appInsights, configStore, debug as d, fs, getHintsFromConfiguration, logger, misc, network, npm, ConnectorConfig, normalizeHints, HintsConfigObject, HintSeverity } from '@hint/utils';
import { Problem, Severity } from '@hint/utils/dist/src/types/problems';

import {
    AnalyzerError,
    AnalyzeOptions,
    CLIOptions,
    CreateAnalyzerOptions,
    HintResources,
    UserConfig
} from '../types';
import { loadHintPackage } from '../utils/packages/load-hint-package';
import { createAnalyzer, getUserConfig } from '../';
import { Analyzer } from '../analyzer';
import { AnalyzerErrorStatus } from '../enums/error-status';

const { getAsUris } = network;
const { askQuestion, mergeEnvWithOptions } = misc;
const { installPackages } = npm;
const { cwd } = fs;
const debug: debug.IDebugger = d(__filename);
const alreadyRunKey: string = 'run';
const spinner = ora({ spinner: 'line' });

/*
 * ------------------------------------------------------------------------------
 * Private
 * ------------------------------------------------------------------------------
 */

const printFrame = (message: string) => {
    logger.log(boxen(message, {
        align: 'center',
        margin: 1,
        padding: 1
    }));
};

/**
 * Prints a message asking user to accept send telemetry data.
 */
const showTelemetryMessage = () => {
    const message: string = `Help us improve webhint
by sending limited usage information
(no personal information or URLs will be sent).

To know more about what information will be sent please
visit ${chalk.default.green('https://webhint.io/docs/user-guide/telemetry/summary/')}`;

    printFrame(message);
};

/**
 * Prints a message asking user to configure the telemetry.
 */
const showCITelemetryMessage = () => {
    const message: string = `Help us improve webhint
by sending limited usage information
(no personal information or URLs will be sent).

To know more about what information will be sent please
visit ${chalk.default.green('https://webhint.io/docs/user-guide/telemetry/summary/')}

Please configure it using
the environment variable HINT_TRACKING to 'on' or 'off'
or set the flag --tracking=on|off`;

    printFrame(message);
};

const getHintsForTelemetry = (hints?: HintsConfigObject | (string | any)[]) => {
    if (!hints) {
        return null;
    }

    const normalizedHints = normalizeHints(hints);
    const result = {} as HintsConfigObject;

    for (const [hintId, severity] of Object.entries(normalizedHints)) {
        result[hintId] = typeof severity === 'string' ? severity : (severity as [HintSeverity, any])[0];
    }

    return result;
};

const pruneUserConfig = (userConfig: UserConfig) => {
    return {
        browserslist: userConfig.browserslist,
        connector: userConfig.connector ? (userConfig.connector as ConnectorConfig).name || userConfig.connector : undefined,
        extends: userConfig.extends,
        formatters: userConfig.formatters,
        hints: getHintsForTelemetry(getHintsFromConfiguration(userConfig)),
        hintsTimeout: userConfig.hintsTimeout,
        language: userConfig.language,
        parsers: userConfig.parsers
    };
};

const askForTelemetryConfirmation = async () => {
    showTelemetryMessage();

    const message = `Do you want to opt-in?`;

    debug(`Prompting telemetry permission.`);

    const telemetryEnabled = await askQuestion(message);

    if (telemetryEnabled) {
        appInsights.enable();
    } else {
        appInsights.disable();
    }

    return telemetryEnabled;
};

/** Ask user if he wants to activate the telemetry or not. */
const sendTelemetryIfEnabled = async (userConfig: UserConfig) => {
    const telemetryConfigured = appInsights.isConfigured();
    let telemetryEnabled = appInsights.isEnabled();
    const alreadyRun: boolean = configStore.get(alreadyRunKey);

    if (!alreadyRun) {
        configStore.set(alreadyRunKey, true);
    }

    if (!telemetryConfigured) {
        if (isCI) {
            showCITelemetryMessage();
            telemetryEnabled = false;
        } else if (alreadyRun) {
            /* Only prompt the user about opt-intelemetry if they have run webhint before. */
            telemetryEnabled = await askForTelemetryConfirmation();

            if (telemetryEnabled) {
                appInsights.trackEvent('cli-telemetry');
            }
        }
    }

    if (!telemetryEnabled) {
        return;
    }

    appInsights.trackEvent('cli-analyze', {
        ci: isCI,
        previouslyRun: alreadyRun,
        ...pruneUserConfig(userConfig)
    });
};

/**
 * Prints a message telling the user a valid configuration couldn't be found and the
 * defaults will be used.
 */
const showDefaultMessage = () => {
    const defaultMessage = `${chalk.default.yellow(`Couldn't find any valid configuration`)}

Running hint with the default configuration.

Learn more about how to create your own configuration at:

${chalk.default.green('https://webhint.io/docs/user-guide/')}`;

    printFrame(defaultMessage);
};

const areFiles = (targets: URL[]) => {
    return targets.every((target) => {
        return target.protocol === 'file:';
    });
};

const anyFile = (targets: URL[]) => {
    return targets.some((target) => {
        return target.protocol === 'file:';
    });
};

/**
 * Prints a message to the screen alerting the user the default configuration
 * will be used and returns the default configuration.
 */
const getDefaultConfiguration = (targets: URL[]) => {
    showDefaultMessage();
    const targetsAreFiles = areFiles(targets);

    if (!targetsAreFiles && anyFile(targets)) {
        // TODO: Improve this message.
        throw new Error('You cannot mix file system with urls in the analysis');
    }

    const ext = targetsAreFiles ? 'development' : 'web-recommended';
    const config = { extends: [ext] } as UserConfig;

    if (isCI) {
        config.formatters = ['html', 'stylish'];
    }

    return config;
};

const askUserToUseDefaultConfiguration = async (targets: URL[]): Promise<UserConfig | null> => {
    const question: string = `A valid configuration file can't be found. Do you want to use the default configuration? To know more about the default configuration see: https://webhint.io/docs/user-guide/#default-configuration`;
    const confirmation: boolean = await askQuestion(question);

    if (confirmation) {
        return getDefaultConfiguration(targets);
    }

    return null;
};

/** Prints the list of missing and incompatible resources found. */
const showMissingAndIncompatiblePackages = (resources: HintResources) => {
    if (resources.missing.length > 0) {
        logger.log(`The following ${resources.missing.length === 1 ? 'package is' : 'packages are'} missing:
    ${resources.missing.join(', ')}`);
    }

    if (resources.incompatible.length > 0) {
        logger.log(`The following ${resources.incompatible.length === 1 ? 'package is' : 'packages are'} incompatible:
    ${resources.incompatible.join(', ')}`);
    }
};

const askUserToInstallDependencies = async (resources: HintResources): Promise<boolean> => {
    showMissingAndIncompatiblePackages(resources);

    const dependencies: string[] = resources.incompatible.concat(resources.missing);

    const question: string = `There ${dependencies.length === 1 ? 'is a package' : 'are packages'} from your .hintrc file not installed or with an incompatible version. Do you want us to try to install/update them?`;

    const answer: boolean = await askQuestion(question);

    return answer;
};

/** Get language. If language is not in the config file or CLI options, get the language configure in the OS. */
const getLanguage = async (userConfig?: UserConfig, actions?: CLIOptions): Promise<string> => {
    if (actions && actions.language) {
        debug(`Using language option provided from command line: ${actions.language}`);

        return actions.language;
    }

    if (userConfig && userConfig.language) {
        debug(`Using language option provided in user config file: ${userConfig.language}`);

        return userConfig.language;
    }

    const osLanguage = await osLocale();

    debug(`Using language option configured in the OS: ${osLanguage}`);

    return osLanguage;
};

const loadUserConfig = async (actions: CLIOptions, targets: URL[]): Promise<UserConfig> => {
    let userConfig = getUserConfig(actions.config);

    if (!userConfig) {
        userConfig = getDefaultConfiguration(targets);
    }

    userConfig.language = await getLanguage(userConfig, actions);
    userConfig = mergeEnvWithOptions(userConfig) as UserConfig;

    return userConfig;
};

const askToInstallPackages = async (resources: HintResources): Promise<boolean> => {
    if (resources.missing.length > 0) {
        appInsights.trackEvent('cli-missing', resources.missing);
    }

    if (resources.incompatible.length > 0) {
        appInsights.trackEvent('cli-incompatible', resources.incompatible);
    }

    const missingPackages = resources.missing.map((name) => {
        return `@hint/${name}`;
    });

    const incompatiblePackages = resources.incompatible.map((name) => {
        // If the packages are incompatible, we need to force to install the latest version.
        return `@hint/${name}@latest`;
    });

    if (!(await askUserToInstallDependencies(resources) &&
        await installPackages(missingPackages) &&
        await installPackages(incompatiblePackages))) {

        // The user doesn't want to install the dependencies or something went wrong installing them
        return false;
    }

    // After installing all the packages, we need to load the resources again.
    return true;
};

const getAnalyzer = async (userConfig: UserConfig, options: CreateAnalyzerOptions, targets: URL[]): Promise<Analyzer> => {
    let webhint: Analyzer;

    try {
        webhint = createAnalyzer(userConfig, options);
    } catch (e) {
        const error = e as AnalyzerError;

        if (error.status === AnalyzerErrorStatus.ConfigurationError) {
            const config = await askUserToUseDefaultConfiguration(targets);

            if (!config) {
                throw e;
            }

            return getAnalyzer(config, options, targets);
        }

        if (error.status === AnalyzerErrorStatus.ResourceError) {
            const installed = await askToInstallPackages(error.resources!);

            if (!installed) {
                throw e;
            }

            return getAnalyzer(userConfig, options, targets);
        }

        if (error.status === AnalyzerErrorStatus.HintError) {
            logger.error(`Invalid hint configuration in .hintrc: ${error.invalidHints!.join(', ')}.`);

            throw e;
        }

        if (error.status === AnalyzerErrorStatus.ConnectorError) {
            logger.error(`Invalid connector configuration in .hintrc`);

            throw e;
        }

        /*
         * If the error is not an AnalyzerErrorStatus
         * bubble up the exception.
         */
        logger.error(e.message, e);

        throw e;
    }

    return webhint;
};

const actionsToOptions = (actions: CLIOptions): CreateAnalyzerOptions => {
    const options: CreateAnalyzerOptions = {
        formatters: actions.formatters ? actions.formatters.split(',') : undefined,
        hints: actions.hints ? actions.hints.split(',') : undefined,
        watch: actions.watch
    };

    return options;
};

/*
 * ------------------------------------------------------------------------------
 * Public
 * ------------------------------------------------------------------------------
 */

/** Analyzes a website if indicated by `actions`. */
export default async (actions: CLIOptions): Promise<boolean> => {
    const targets = getAsUris(actions._);

    if (targets.length === 0) {
        return false;
    }

    const userConfig = await loadUserConfig(actions, targets);

    const createAnalyzerOptions = actionsToOptions(actions);
    let webhint: Analyzer;

    try {
        webhint = await getAnalyzer(userConfig, createAnalyzerOptions, targets);
    } catch (e) {
        return false;
    }

    const start = Date.now();
    let exitCode = 0;

    const endSpinner = (method: string) => {
        if (!actions.debug && (spinner as any)[method]) {
            (spinner as any)[method]();
        }
    };

    const hasError = (reports: Problem[]): boolean => {
        return reports.some((result: Problem) => {
            return result.severity === Severity.error;
        });
    };

    const print = async (reports: Problem[], target?: string, scanTime?: number, date?: string): Promise<void> => {
        await webhint.format(reports, {
            config: userConfig || undefined,
            date,
            output: actions.output ? path.resolve(cwd(), actions.output) : undefined,
            resources: webhint.resources,
            scanTime,
            target,
            version: loadHintPackage().version
        });
    };

    const getAnalyzeOptions = (): AnalyzeOptions => {
        const scanStart = new Map<string, number>();
        const analyzerOptions: AnalyzeOptions = {
            targetEndCallback: undefined,
            targetStartCallback: undefined,
            updateCallback: undefined
        };

        /* istanbul ignore else */
        if (!actions.debug) {
            analyzerOptions.updateCallback = (update) => {
                spinner.text = update.message;
            };
        }

        analyzerOptions.targetStartCallback = (start) => {
            if (!actions.debug) {
                spinner.start();
            }
            scanStart.set(start.url, Date.now());
        };
        analyzerOptions.targetEndCallback = async (end) => {
            const scanEnd = Date.now();
            const start = scanStart.get(end.url) || 0;

            if (hasError(end.problems)) {
                exitCode = 1;
            }

            endSpinner(exitCode ? 'fail' : 'succeed');

            await print(end.problems, end.url, scanEnd - start, new Date(start).toISOString());
        };

        return analyzerOptions;
    };

    try {
        await webhint.analyze(targets, getAnalyzeOptions());

        await sendTelemetryIfEnabled(userConfig!);
    } catch (e) {
        exitCode = 1;
        endSpinner('fail');
        debug(`Failed to analyze: ${e.url}`);
        debug(e);
    }

    debug(`Total runtime: ${Date.now() - start}ms`);

    return exitCode === 0;
};

import hammerhead from './deps/hammerhead';
import testCafeCore from './deps/testcafe-core';
import testCafeUI from './deps/testcafe-ui';
import StepIterator from './step-iterator.js';
import AssertionsAPI from './api/assertions';
import actionsAPI from './api/actions';
import * as dialogsAPI from './api/native-dialogs';
import initAutomation from './init-automation';
import SETTINGS from './settings';
import CROSS_DOMAIN_MESSAGES from './cross-domain-messages';
import COMMAND from '../test-run/command';
import ERROR_TYPE from '../test-run-error/type';
import * as sandboxedJQuery from './sandboxed-jquery';
import * as transport from './transport';
import isJQueryObj from '../utils/is-jquery-obj';

var messageSandbox = hammerhead.eventSandbox.message;
var nativeMethods  = hammerhead.nativeMethods;

var RequestEmitter = testCafeCore.ClientRequestEmitter;
var RequestBarrier = testCafeCore.RequestBarrier;
var serviceUtils   = testCafeCore.serviceUtils;
var domUtils       = testCafeCore.domUtils;
var eventUtils     = testCafeCore.eventUtils;
var JSON           = hammerhead.json;

var modalBackground = testCafeUI.modalBackground;


const ANIMATIONS_WAIT_DELAY              = 200;
const CHECK_FILE_DOWNLOADING_DELAY       = 500;
const IFRAME_EXISTENCE_WATCHING_INTERVAL = 1000;


//Init
var RunnerBase = function () {
    var runner = this;

    this.eventEmitter = new serviceUtils.EventEmitter();
    this.stepIterator = new StepIterator(pingIframe);

    this.executingStepInIFrameWindow      = null;
    this.stopped                          = false;
    this.listenNativeDialogs              = false;
    this.isFileDownloadingIntervalID      = null;
    this.iframeActionTargetWaitingStarted = false;

    this.pageInitialRequestBarrier = null;

    this.assertionsAPI = new AssertionsAPI(function (err) {
        runner.stepIterator.onAssertionFailed(err);
    });

    actionsAPI.init(this.stepIterator);

    this._initNativeDialogs();

    initAutomation();
    this._initBarrier();

    this._initApi();
    this._initIFrameBehavior();

    hammerhead.on(hammerhead.EVENTS.uncaughtJsError, function (err) {
        //NOTE: in this case we should to stop test iterator in iFrame
        if (err.inIFrame && !SETTINGS.get().PLAYBACK)
            runner.stepIterator.stop();
        else if (!SETTINGS.get().SKIP_JS_ERRORS || SETTINGS.get().RECORDING) {
            runner._onFatalError({
                type:        ERROR_TYPE.uncaughtJSError,
                scriptErr:   err.msg,
                pageError:   true,
                pageDestUrl: err.pageUrl,
                stepName:    runner.stepIterator.getCurrentStep()
            });
        }
    });

    runner.stepIterator.on(StepIterator.ERROR_EVENT, function (e) {
        runner._onFatalError(e);
    });

    runner.act._onJSError = function (err) {
        runner._onFatalError({
            type:      ERROR_TYPE.uncaughtJSError,
            scriptErr: (err && err.message) || err
        });
    };

    runner.act._start = function (stepNames, testSteps, skipPageWaiting) {
        //NOTE: start test execution only when all content is loaded or if loading
        //timeout is reached (whichever comes first).
        runner._prepareStepsExecuting(function () {
            if (runner.stopped)
                return;

            delete runner.act._onJSError;
            delete runner.act._start;

            runner.eventEmitter.emit(runner.TEST_STARTED_EVENT, {
                nextStep: runner.nextStep
            });

            modalBackground.hide();

            runner.stepIterator.on(StepIterator.TEST_COMPLETE_EVENT, function (e) {
                runner._onTestComplete(e);
            });

            runner.stepIterator.on(StepIterator.NEXT_STEP_STARTED_EVENT, function (e) {
                runner._onNextStepStarted(e);
                runner._clearFileDownloadingInterval();
            });

            runner.stepIterator.on(StepIterator.ACTION_TARGET_WAITING_STARTED_EVENT, function (e) {
                runner._onActionTargetWaitingStarted(e);
            });

            runner.stepIterator.on(StepIterator.ACTION_RUN_EVENT, function () {
                runner._onActionRun();
            });

            runner.stepIterator.on(StepIterator.ASSERTION_FAILED_EVENT, function (e) {
                runner._onAssertionFailed(e);
            });

            runner.stepIterator.on(StepIterator.SET_STEPS_SHARED_DATA_EVENT, function (e) {
                runner._onSetStepsSharedData(e);
            });

            runner.stepIterator.on(StepIterator.GET_STEPS_SHARED_DATA_EVENT, function (e) {
                runner._onGetStepsSharedData(e);
            });

            runner.stepIterator.on(StepIterator.TAKE_SCREENSHOT_EVENT, function (e) {
                runner._onTakeScreenshot(e);
            });

            runner.stepIterator.on(StepIterator.BEFORE_UNLOAD_EVENT_RAISED, function () {
                runner._onBeforeUnload();
            });

            runner.stepIterator.on(StepIterator.UNLOAD_EVENT_RAISED, function () {
                runner._clearFileDownloadingInterval();
            });

            runner.listenNativeDialogs = true;

            runner.stepIterator.start(stepNames, testSteps, dialogsAPI.resetHandlers,
                dialogsAPI.checkExpectedDialogs, runner.nextStep);
        }, skipPageWaiting);
    };
};

RunnerBase.prototype.run = function (stepNames, testSteps, nextStep) {
    this.stepIterator.runSteps(stepNames, testSteps, dialogsAPI.resetHandlers,
        dialogsAPI.checkExpectedDialogs, nextStep);
};

RunnerBase.prototype._destroy = function () {
    dialogsAPI.destroy();

    this._destroyIFrameBehavior();
};

RunnerBase.prototype._initBarrier = function () {
    var requestEmitter = new RequestEmitter();

    this.pageInitialRequestBarrier = new RequestBarrier(requestEmitter, {
        requestsCollection:           SETTINGS.get().REQUESTS_COLLECTION_DELAY,
        additionalRequestsCollection: SETTINGS.get().ADDITIONAL_REQUESTS_COLLECTION_DELAY
    });
};

RunnerBase.prototype._initIFrameBehavior = function () {
    var runner = this;

    function onMessage (e) {
        var message = e.message,
            msg     = null;

        switch (message.cmd) {
            case RunnerBase.IFRAME_STEP_COMPLETED_CMD:
                if (runner.stepIterator.waitedIFrame === domUtils.findIframeByWindow(e.source, window.top))
                    runner.stepIterator.iFrameActionCallback();
                else if (runner.executingStepInIFrameWindow === e.source)
                    runner._onIFrameStepExecuted();

                runner._clearIFrameExistenceWatcherInterval();
                break;

            case RunnerBase.IFRAME_ERROR_CMD:
                if (message.err.stepNum === -1) {
                    message.err.stepNum  = runner.stepIterator.getCurrentStepNum();
                    message.err.stepName = runner.stepIterator.getCurrentStep();
                }
                runner._clearIFrameExistenceWatcherInterval();
                runner._onFatalError(message.err);
                break;

            case RunnerBase.IFRAME_FAILED_ASSERTION_CMD:
                if (SETTINGS.get().PLAYBACK)
                    runner.executingStepInIFrameWindow = null;

                message.err.stepNum = runner.stepIterator.state.step - 1;
                runner._onAssertionFailed(message.err);
                break;

            case RunnerBase.IFRAME_GET_SHARED_DATA_REQUEST_CMD:
                msg = {
                    cmd:        RunnerBase.IFRAME_GET_SHARED_DATA_RESPONSE_CMD,
                    sharedData: runner.stepIterator.getSharedData()
                };

                messageSandbox.sendServiceMsg(msg, e.source);
                break;

            case RunnerBase.IFRAME_SET_SHARED_DATA_CMD:
                runner.stepIterator.setSharedData(JSON.parse(message.sharedData));
                break;

            case RunnerBase.IFRAME_NEXT_STEP_STARTED_CMD:
                runner.executingStepInIFrameWindow = e.source;
                runner._clearFileDownloadingInterval();

                break;

            case RunnerBase.IFRAME_ACTION_TARGET_WAITING_STARTED_CMD:
                runner.iframeActionTargetWaitingStarted = true;
                runner._onActionTargetWaitingStarted(e.message.params);
                break;

            case RunnerBase.IFRAME_ACTION_RUN_CMD:
                runner.iframeActionTargetWaitingStarted = false;
                runner._onActionRun();
                break;

            case CROSS_DOMAIN_MESSAGES.IFRAME_TEST_RUNNER_WAITING_STEP_COMPLETION_REQUEST_CMD:
                if (runner.stepIterator.waitedIFrame === domUtils.findIframeByWindow(e.source, window.top) ||
                    runner.executingStepInIFrameWindow === e.source) {
                    msg = {
                        cmd: CROSS_DOMAIN_MESSAGES.IFRAME_TEST_RUNNER_WAITING_STEP_COMPLETION_RESPONSE_CMD
                    };

                    messageSandbox.sendServiceMsg(msg, e.source);
                }
                break;

            case RunnerBase.IFRAME_TAKE_SCREENSHOT_REQUEST_CMD:
                runner._onTakeScreenshot({
                    filePath: message.filePath,
                    callback: function () {
                        msg = {
                            cmd: RunnerBase.IFRAME_TAKE_SCREENSHOT_RESPONSE_CMD
                        };

                        messageSandbox.sendServiceMsg(msg, e.source);
                    }
                });
                break;

            case RunnerBase.IFRAME_NATIVE_DIALOGS_INFO_CHANGED_CMD:
                runner._onDialogsInfoChanged(message.info);
                break;

            case RunnerBase.IFRAME_BEFORE_UNLOAD_REQUEST_CMD:
                runner._onActionRun();

                runner._onBeforeUnload(true, function (res) {
                    msg = {
                        cmd: RunnerBase.IFRAME_BEFORE_UNLOAD_RESPONSE_CMD,
                        res: res
                    };
                    messageSandbox.sendServiceMsg(msg, e.source);
                });
                break;
        }
    }

    messageSandbox.on(messageSandbox.SERVICE_MSG_RECEIVED_EVENT, onMessage);

    //NOTE: for test purposes
    runner._destroyIFrameBehavior = function () {
        messageSandbox.off(messageSandbox.SERVICE_MSG_RECEIVED_EVENT, onMessage);
    };
};

RunnerBase.prototype._prepareStepsExecuting = function (callback, skipPageWaiting) {
    if (skipPageWaiting)
        callback();
    else {
        eventUtils
            .documentReady()
            .then(() => {
                nativeMethods.setTimeout.call(window, () => {
                    transport.batchUpdate(() => {
                        this.pageInitialRequestBarrier
                            .wait(true)
                            .then(callback);
                    });
                }, ANIMATIONS_WAIT_DELAY);
            });
    }
};

RunnerBase.WAITING_FOR_ACTION_TARGET_MESSAGE = 'Waiting for the target element of the next action to appear';

RunnerBase.prototype.TEST_STARTED_EVENT                  = 'testStarted';
RunnerBase.prototype.TEST_COMPLETED_EVENT                = 'testCompleted';
RunnerBase.prototype.NEXT_STEP_STARTED_EVENT             = 'nextStepStarted';
RunnerBase.prototype.ACTION_TARGET_WAITING_STARTED_EVENT = 'actionTargetWaitingStarted';
RunnerBase.prototype.ACTION_RUN_EVENT                    = 'actionRun';
RunnerBase.prototype.TEST_FAILED_EVENT                   = 'testFailed';

RunnerBase.SCREENSHOT_CREATING_STARTED_EVENT  = 'screenshotCreatingStarted';
RunnerBase.SCREENSHOT_CREATING_FINISHED_EVENT = 'screenshotCreatingFinished';

RunnerBase.IFRAME_STEP_COMPLETED_CMD                = 'iframeStepCompleted';
RunnerBase.IFRAME_ERROR_CMD                         = 'iframeError';
RunnerBase.IFRAME_FAILED_ASSERTION_CMD              = 'iframeFailedAssertion';
RunnerBase.IFRAME_GET_SHARED_DATA_REQUEST_CMD       = 'getSharedDataRequest';
RunnerBase.IFRAME_GET_SHARED_DATA_RESPONSE_CMD      = 'getSharedDataResponse';
RunnerBase.IFRAME_SET_SHARED_DATA_CMD               = 'setSharedData';
RunnerBase.IFRAME_NEXT_STEP_STARTED_CMD             = 'nextStepStarted';
RunnerBase.IFRAME_ACTION_TARGET_WAITING_STARTED_CMD = 'actionTargetWaitingStarted';
RunnerBase.IFRAME_ACTION_RUN_CMD                    = 'actionRun';
RunnerBase.IFRAME_TAKE_SCREENSHOT_REQUEST_CMD       = 'takeScreenshotRequest';
RunnerBase.IFRAME_TAKE_SCREENSHOT_RESPONSE_CMD      = 'takeScreenshotResponse';
RunnerBase.IFRAME_NATIVE_DIALOGS_INFO_CHANGED_CMD   = 'nativeDialogsInfoChanged';
RunnerBase.IFRAME_BEFORE_UNLOAD_REQUEST_CMD         = 'iframeBeforeUnloadRequest';
RunnerBase.IFRAME_BEFORE_UNLOAD_RESPONSE_CMD        = 'iframeBeforeUnloadResponse';

RunnerBase.prototype.on = function (event, handler) {
    this.eventEmitter.on(event, handler);
};

function pingIframe (iframe) {
    return messageSandbox.pingIframe(iframe, CROSS_DOMAIN_MESSAGES.IFRAME_TEST_RUNNER_PING_DISPATCHER_CMD);
}

RunnerBase.prototype._runInIFrame = function (iframe, stepName, step, stepNum) {
    var runner = this;

    this.stepIterator.state.inAsyncAction = true;

    var msg = {
        cmd:      CROSS_DOMAIN_MESSAGES.IFRAME_TEST_RUNNER_RUN_CMD,
        stepName: stepName,
        step:     step.toString(),
        stepNum:  stepNum
    };

    this._clearIFrameExistenceWatcherInterval();

    function iframeExistenceWatcher () {
        if (!domUtils.isElementInDocument(iframe)) {
            runner._onIFrameStepExecuted();
            runner._clearIFrameExistenceWatcherInterval();
        }
    }

    pingIframe(iframe)
        .then(() => {
            runner.iframeExistenceWatcherInterval = nativeMethods.setInterval.call(window, iframeExistenceWatcher, IFRAME_EXISTENCE_WATCHING_INTERVAL);
            messageSandbox.sendServiceMsg(msg, iframe.contentWindow);
        })
        .catch(() => {
            runner._onFatalError({
                type:     ERROR_TYPE.inIFrameTargetLoadingTimeout,
                stepName: runner.stepIterator.getCurrentStep()
            });
        });
};

RunnerBase.prototype._ensureIFrame = function (arg) {
    if (!arg) {
        this._onFatalError({
            type:     ERROR_TYPE.emptyIFrameArgument,
            stepName: this.stepIterator.getCurrentStep()
        });
        return null;
    }

    if (domUtils.isDomElement(arg)) {
        if (arg.tagName && domUtils.isIframeElement(arg))
            return arg;
        else {
            this._onFatalError({
                type:     ERROR_TYPE.iframeArgumentIsNotIFrame,
                stepName: this.stepIterator.getCurrentStep()
            });
            return null;
        }
    }

    if (typeof arg === 'string')
        arg = sandboxedJQuery.jQuery(arg);

    if (isJQueryObj(arg)) {
        if (arg.length === 0) {
            this._onFatalError({
                type:     ERROR_TYPE.emptyIFrameArgument,
                stepName: this.stepIterator.getCurrentStep()
            });
            return null;
        }
        else if (arg.length > 1) {
            this._onFatalError({
                type:     ERROR_TYPE.multipleIFrameArgument,
                stepName: this.stepIterator.getCurrentStep()
            });
            return null;
        }
        else
            return this._ensureIFrame(arg[0]);
    }

    if (typeof arg === 'function')
        return this._ensureIFrame(arg());

    this._onFatalError({
        type:     ERROR_TYPE.incorrectIFrameArgument,
        stepName: this.stepIterator.getCurrentStep()
    });

    return null;
};

//API
RunnerBase.prototype._initApi = function () {
    var runner = this;

    this.act = actionsAPI;

    this.ok                 = function () {
        runner.assertionsAPI.ok.apply(runner.assertionsAPI, arguments);
    };
    this.notOk              = function () {
        runner.assertionsAPI.notOk.apply(runner.assertionsAPI, arguments);
    };
    this.eq                 = function () {
        runner.assertionsAPI.eq.apply(runner.assertionsAPI, arguments);
    };
    this.notEq              = function () {
        runner.assertionsAPI.notEq.apply(runner.assertionsAPI, arguments);
    };
    this.handleAlert        = dialogsAPI.handleAlert;
    this.handleConfirm      = dialogsAPI.handleConfirm;
    this.handlePrompt       = dialogsAPI.handlePrompt;
    this.handleBeforeUnload = dialogsAPI.handleBeforeUnload;
    this.inIFrame           = function (iFrameGetter, step) {
        return function () {
            var stepNum = runner.stepIterator.state.step,
                iFrame  = runner._ensureIFrame(iFrameGetter());

            if (iFrame)
                runner._runInIFrame(iFrame, runner.stepIterator.getCurrentStep(), step, stepNum);
        };
    };
};

RunnerBase.prototype._initNativeDialogs = function () {
    //NOTE: this method should be synchronous because we should have this info before page scripts are executed
    var runner = this;

    if (SETTINGS.get().NATIVE_DIALOGS_INFO)
        runner.listenNativeDialogs = true;

    dialogsAPI.init(SETTINGS.get().NATIVE_DIALOGS_INFO);

    dialogsAPI.on(dialogsAPI.UNEXPECTED_DIALOG_ERROR_EVENT, function (e) {
        if (runner.listenNativeDialogs) {
            runner.stepIterator.onError({
                type:     ERROR_TYPE.unexpectedDialog,
                stepName: runner.stepIterator.getCurrentStep(),
                dialog:   e.dialog,
                message:  e.message
            });
        }
    });

    dialogsAPI.on(dialogsAPI.WAS_NOT_EXPECTED_DIALOG_ERROR_EVENT, function (e) {
        if (runner.listenNativeDialogs) {
            runner.stepIterator.onError({
                type:     ERROR_TYPE.expectedDialogDoesntAppear,
                stepName: runner.stepIterator.getCurrentStep(),
                dialog:   e.dialog
            });
        }
    });

    dialogsAPI.on(dialogsAPI.DIALOGS_INFO_CHANGED_EVENT, function (e) {
        runner._onDialogsInfoChanged(e.info);
    });
};
//Handlers
RunnerBase.prototype._onTestComplete    = function (e) {
    this.stopped = true;
    this.eventEmitter.emit(this.TEST_COMPLETED_EVENT, {});
    e.callback();
};

RunnerBase.prototype._onNextStepStarted = function (e) {
    e.callback();
};

RunnerBase.prototype._onActionTargetWaitingStarted = function (e) {
    this.eventEmitter.emit(this.ACTION_TARGET_WAITING_STARTED_EVENT, e);
};

RunnerBase.prototype._onActionRun = function () {
    this.eventEmitter.emit(this.ACTION_RUN_EVENT, {});
};

RunnerBase.prototype._onFatalError = function (err) {
    this.eventEmitter.emit(this.TEST_FAILED_EVENT, {
        stepNum: this.stepIterator.state.step - 1,
        err:     err
    });
};

RunnerBase.prototype._onAssertionFailed = function () {
};

RunnerBase.prototype._onSetStepsSharedData = function (e) {
    e.callback();
};

RunnerBase.prototype._onGetStepsSharedData = function (e) {
    e.callback();
};

RunnerBase.prototype._onTakeScreenshot = function (e) {
    if (e && e.callback)
        e.callback();
};

RunnerBase.prototype._onIFrameStepExecuted = function () {
    this.executingStepInIFrameWindow = null;

    if (this.iframeActionTargetWaitingStarted) {
        this.iframeActionTargetWaitingStarted = false;
        this.stepIterator.runLast();
    }
    else
        this.stepIterator.runNext();
};

RunnerBase.prototype._onDialogsInfoChanged = function () {
};

RunnerBase.prototype.setGlobalWaitFor = function (event, timeout) {
    this.stepIterator.setGlobalWaitFor(event, timeout);
};

RunnerBase.prototype._onBeforeUnload = function (fromIFrame, callback) {
    var runner = this;

    if (this.stopped)
        return;

    //NOTE: we need check it to determinate file downloading
    runner.isFileDownloadingIntervalID = nativeMethods.setInterval.call(window, function () {
        transport.asyncServiceMsg({ cmd: COMMAND.getAndUncheckFileDownloadingFlag }, function (res) {
            if (res) {
                window.clearInterval(runner.isFileDownloadingIntervalID);
                runner.isFileDownloadingIntervalID = null;

                if (fromIFrame) {
                    callback(res);
                    return;
                }

                if (runner.stepIterator.state.stepDelayTimeout) {
                    window.clearTimeout(runner.stepIterator.state.stepDelayTimeout);
                    runner.stepIterator.state.stepDelayTimeout = null;
                }

                runner.stepIterator.state.pageUnloading = false;
                runner.stepIterator._runStep();
            }
        });
    }, CHECK_FILE_DOWNLOADING_DELAY);
};

RunnerBase.prototype._clearFileDownloadingInterval = function () {
    if (this.isFileDownloadingIntervalID) {
        window.clearInterval(this.isFileDownloadingIntervalID);
        this.isFileDownloadingIntervalID = null;
    }
};

RunnerBase.prototype._clearIFrameExistenceWatcherInterval = function () {
    if (this.iframeExistenceWatcherInterval !== -1) {
        window.clearInterval(this.iframeExistenceWatcherInterval);
        this.iframeExistenceWatcherInterval = -1;
    }
};


export default RunnerBase;

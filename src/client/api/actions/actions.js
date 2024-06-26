import hammerhead from '../../deps/hammerhead';
import testCafeCore from '../../deps/testcafe-core';
import testCafeUI from '../../deps/testcafe-ui';

import {
    getOffsetOptions as getAutomationOffsetOptions,
    MouseOptions,
    ClickOptions,
    TypeOptions,
    calculateSelectTextArguments,
} from '../../deps/testcafe-automation';

import { getAutomations } from '../../automation-storage';
import SETTINGS from '../../settings';
import * as sourceIndexTracker from '../../source-index';
import forEachSeries from '../../deps/for-each-series';
import * as sandboxedJQuery from '../../sandboxed-jquery';
import ERROR_TYPE from '../../../test-run-error/type';
import isJQueryObj from '../../../utils/is-jquery-obj';

var nativeMethods = hammerhead.nativeMethods;

var contentEditable  = testCafeCore.contentEditable;
var domUtils         = testCafeCore.domUtils;
var positionUtils    = testCafeCore.positionUtils;
var styleUtils       = testCafeCore.styleUtils;
var arrayUtils       = testCafeCore.arrayUtils;
var parseKeySequence = testCafeCore.parseKeySequence;
var selectElement    = testCafeUI.selectElement;
var TEST_RUN_ERRORS  = testCafeCore.TEST_RUN_ERRORS;


const ELEMENT_AVAILABILITY_WAITING_DELAY = 200;
const WAIT_FOR_DEFAULT_TIMEOUT           = 10000;
const CHECK_CONDITION_INTERVAL           = 50;


//Global
var stepIterator = null;

function ensureArray (target) {
    return arrayUtils.isArray(target) ? target : [target];
}

function isStringOrStringArray (target, forbidEmptyArray) {
    if (typeof target === 'string')
        return true;

    if (arrayUtils.isArray(target) && (!forbidEmptyArray || target.length)) {
        for (var i = 0; i < target.length; i++) {
            if (typeof target[i] !== 'string')
                return false;
        }

        return true;
    }

    return false;
}

function failWithError (type, additionalParams) {
    var err = {
        type:          type,
        stepName:      SETTINGS.get().CURRENT_TEST_STEP_NAME,
        __sourceIndex: sourceIndexTracker.currentIndex
    };

    if (additionalParams) {
        for (var key in additionalParams) {
            if (additionalParams.hasOwnProperty(key)) {
                err[key] = additionalParams[key];
            }
        }
    }

    stepIterator.onError(err);
}

function failIfActionElementIsInvisible (err, type, element) {
    // NOTE: in case we couldn't find an element for event
    // simulation, we raise an error of this type (GH - 337)
    if (err.code === TEST_RUN_ERRORS.actionElementIsInvisibleError ||
            err.code === TEST_RUN_ERRORS.actionAdditionalElementIsInvisibleError) {
        failWithError(ERROR_TYPE.invisibleActionElement, {
            element: domUtils.getElementDescription(element),
            action:  type
        });
    }
}

function ensureElementsExist (item, actionName, callback) {
    var success = false;

    var ensureExists = function () {
        var array = null;

        if (typeof item === 'function') {
            var res = item();

            array = ensureArray(res);

            if (res && !(isJQueryObj(res) && !res.length) && array.length) {
                callback(array);
                return true;
            }
        }
        else if (typeof item === 'string') {
            array = parseActionArgument(item, actionName);

            if (array && array.length) {
                callback(array);
                return true;
            }
        }

        return false;
    };

    if (ensureExists())
        return;

    var interval = nativeMethods.setInterval.call(window, function () {
        if (ensureExists()) {
            success = true;
            window.clearInterval(interval);
        }
    }, ELEMENT_AVAILABILITY_WAITING_DELAY);

    nativeMethods.setTimeout.call(window, function () {
        if (!success) {
            window.clearInterval(interval);
            failWithError(ERROR_TYPE.emptyFirstArgument, { action: actionName });
        }
    }, SETTINGS.get().SELECTOR_TIMEOUT);
}

function ensureElementVisibility (element, actionName, callback) {
    var success = false;

    if (domUtils.isOptionElement(element) || domUtils.getTagName(element) === 'optgroup') {
        if (selectElement.isOptionElementVisible(element))
            callback();
        else {
            failWithError(ERROR_TYPE.invisibleActionElement, {
                element: domUtils.getElementDescription(element),
                action:  actionName
            });
        }

        return;
    }

    if (positionUtils.isElementVisible(element)) {
        callback();
        return;
    }

    var interval = nativeMethods.setInterval.call(window, function () {
        if (positionUtils.isElementVisible(element)) {
            success = true;
            window.clearInterval(interval);
            callback();
        }
    }, ELEMENT_AVAILABILITY_WAITING_DELAY);

    nativeMethods.setTimeout.call(window, function () {
        if (!success) {
            window.clearInterval(interval);

            failWithError(ERROR_TYPE.invisibleActionElement, {
                element: domUtils.getElementDescription(element),
                action:  actionName
            });
        }
    }, SETTINGS.get().SELECTOR_TIMEOUT);
}

function actionArgumentsIterator (actionName) {
    var runAction = null;

    var iterate = function (item, iterationCallback) {
        if (arrayUtils.isArray(item))
            extractArgs(item, iterationCallback);
        else if (typeof item === 'function') {
            ensureElementsExist(item, actionName, function (elementsArray) {
                extractArgs(elementsArray, iterationCallback);
            });
        }
        else if (typeof item === 'string') {
            ensureElementsExist(item, actionName, function (elementsArray) {
                runAction(elementsArray, function () {
                    iterationCallback();
                });
            });
        }
        else {
            var elementsArray = parseActionArgument(item, actionName);
            if (!elementsArray || elementsArray.length < 1)
                failWithError(ERROR_TYPE.emptyFirstArgument, { action: actionName });
            else
                runAction(elementsArray, function () {
                    iterationCallback();
                });
        }
    };

    var extractArgs = function (items, callback) {
        if (!items.length) {
            failWithError(ERROR_TYPE.emptyFirstArgument, { action: actionName });
        }
        else {
            forEachSeries(
                items,
                function (item, seriaCallback) {
                    iterate(item, seriaCallback);
                },
                function () {
                    callback();
                }
            );
        }
    };

    return {
        run: function (items, actionRunner, callback) {
            onTargetWaitingStarted();
            runAction = actionRunner;
            extractArgs(items, callback);
        }
    };
}

function pressActionArgumentsIterator () {
    return {
        run: function (items, actionRunner, callback) {
            actionRunner(items, callback);
        }
    };
}

function onTargetWaitingStarted (isWaitAction) {
    stepIterator.onActionTargetWaitingStarted({
        isWaitAction: isWaitAction
    });
}

function onTargetWaitingFinished () {
    stepIterator.onActionRun();
}

function getSelectAutomationArgumentsObject (element, apiArgs) {
    var argsLength = apiArgs.length;

    if (argsLength === 1)
        return { offset: apiArgs[0] };
    else if (argsLength === 2 || argsLength > 2 && !domUtils.isTextAreaElement(element)) {
        if (!isNaN(parseInt(apiArgs[0], 10))) {
            return {
                startPos: apiArgs[0],
                endPos:   apiArgs[1]
            };
        }
        else {
            return {
                startNode: apiArgs[0],
                endNode:   apiArgs[1]
            };
        }
    }
    else if (apiArgs.length > 2) {
        return {
            startLine: apiArgs[0],
            startPos:  apiArgs[1],
            endLine:   apiArgs[2],
            endPos:    apiArgs[3]
        };
    }
}

//function exports only for tests
export function parseActionArgument (item, actionName) {
    var elements = [];

    if (domUtils.isDomElement(item))
        return [item];
    else if (actionName && actionName === 'select' && domUtils.isTextNode(item))
        return [item];
    else if (typeof item === 'string')
        return arrayUtils.from(sandboxedJQuery.jQuery(item));
    else if (isJQueryObj(item)) {
        item.each(function () {
            elements.push(this);
        });

        return elements;
    }
    else
        return null;
}

export function init (iterator) {
    stepIterator = iterator;
}

export function click (what, options) {
    var actionStarted = false,
        actionType    = 'click',
        elements      = ensureArray(what);

    stepIterator.asyncActionSeries(
        elements,
        actionArgumentsIterator(actionType).run,
        function (element, callback, iframe) {
            ensureElementVisibility(element, actionType, function () {
                if (!actionStarted) {
                    actionStarted = true;
                    onTargetWaitingFinished();
                }

                options = options || {};

                var { offsetX, offsetY } = getAutomationOffsetOptions(element, options.offsetX, options.offsetY);

                var clickOptions = new ClickOptions({
                    offsetX,
                    offsetY,
                    caretPos:  options.caretPos,
                    modifiers: options
                }, false);

                var targetWindow        = iframe ? iframe.contentWindow : window;
                var ClickAutomationCtor = /option|optgroup/.test(domUtils.getTagName(element)) ?
                                          getAutomations(targetWindow).SelectChildClick : getAutomations(targetWindow).Click;

                var clickAutomation = new ClickAutomationCtor(element, clickOptions);

                clickAutomation
                    .run()
                    .catch(err => failIfActionElementIsInvisible(err, actionType, element))
                    .then(function () {
                        callback();
                    });
            });
        });
}

export function rclick (what, options) {
    var actionStarted = false,
        actionType    = 'rclick',
        elements      = ensureArray(what);

    stepIterator.asyncActionSeries(
        elements,
        actionArgumentsIterator(actionType).run,
        function (element, callback, iframe) {
            ensureElementVisibility(element, actionType, function () {
                if (!actionStarted) {
                    actionStarted = true;
                    onTargetWaitingFinished();
                }

                options = options || {};

                var { offsetX, offsetY } = getAutomationOffsetOptions(element, options.offsetX, options.offsetY);

                var clickOptions = new ClickOptions({
                    offsetX,
                    offsetY,
                    caretPos:  options.caretPos,
                    modifiers: options
                }, false);

                var targetWindow         = iframe ? iframe.contentWindow : window;
                var RClickAutomationCtor = getAutomations(targetWindow).RClick;
                var rClickAutomation     = new RClickAutomationCtor(element, clickOptions);

                rClickAutomation
                    .run()
                    .catch(err => failIfActionElementIsInvisible(err, actionType, element))
                    .then(callback);
            });
        });
}

export function dblclick (what, options) {
    var actionStarted = false,
        actionType    = 'dblclick',
        elements      = ensureArray(what);

    stepIterator.asyncActionSeries(
        elements,
        actionArgumentsIterator(actionType).run,
        function (element, callback, iframe) {
            ensureElementVisibility(element, actionType, function () {
                if (!actionStarted) {
                    actionStarted = true;
                    onTargetWaitingFinished();
                }

                options = options || {};

                var { offsetX, offsetY } = getAutomationOffsetOptions(element, options.offsetX, options.offsetY);

                var clickOptions = new ClickOptions({
                    offsetX,
                    offsetY,
                    caretPos:  options.caretPos,
                    modifiers: options
                }, false);

                var targetWindow           = iframe ? iframe.contentWindow : window;
                var DblClickAutomationCtor = getAutomations(targetWindow).DblClick;
                var dblClickAutomation     = new DblClickAutomationCtor(element, clickOptions);

                dblClickAutomation
                    .run()
                    .catch(err => failIfActionElementIsInvisible(err, actionType, element))
                    .then(function () {
                        callback();
                    });
            });
        });
}

export function drag (what) {
    var actionStarted      = false;
    var actionType         = 'drag';
    var args               = arguments;
    var elements           = ensureArray(what);
    var secondArgIsCoord   = !(isNaN(parseInt(args[1])));
    var dragAutomation     = null;
    var options            = secondArgIsCoord ? args[3] : args[2];
    var destinationElement = null;
    var dragOffsetX        = null;
    var dragOffsetY        = null;

    if (args.length > 2 && secondArgIsCoord) {
        dragOffsetX = args[1];
        dragOffsetY = args[2];
    }
    else {
        destinationElement = args[1];

        if (!destinationElement) {
            failWithError(ERROR_TYPE.incorrectDraggingSecondArgument);
            return;
        }
    }

    if (isJQueryObj(destinationElement)) {
        if (destinationElement.length < 1) {
            failWithError(ERROR_TYPE.incorrectDraggingSecondArgument);
            return;
        }
        else
            destinationElement = destinationElement[0];
    }
    else if (!domUtils.isDomElement(destinationElement) &&
             (isNaN(parseInt(dragOffsetX)) || isNaN(parseInt(dragOffsetY)))) {
        failWithError(ERROR_TYPE.incorrectDraggingSecondArgument);
        return;
    }

    stepIterator.asyncActionSeries(
        elements,
        actionArgumentsIterator(actionType).run,
        function (element, callback, iframe) {
            ensureElementVisibility(element, actionType, function () {
                if (!actionStarted) {
                    actionStarted = true;
                    onTargetWaitingFinished();
                }

                options = options || {};

                var { offsetX, offsetY } = getAutomationOffsetOptions(element, options.offsetX, options.offsetY);

                // NOTE: Need to round offsets due to GH-365
                dragOffsetX = Math.round(dragOffsetX);
                dragOffsetY = Math.round(dragOffsetY);

                var mouseOptions = new MouseOptions({
                    offsetX,
                    offsetY,
                    modifiers: options
                }, false);

                var targetWindow       = iframe ? iframe.contentWindow : window;
                var DragAutomationCtor = null;

                if (destinationElement) {
                    DragAutomationCtor = getAutomations(targetWindow).DragToElement;
                    dragAutomation     = new DragAutomationCtor(element, destinationElement, mouseOptions);
                }
                else {
                    DragAutomationCtor = getAutomations(targetWindow).DragToOffset;
                    dragAutomation     = new DragAutomationCtor(element, dragOffsetX, dragOffsetY, mouseOptions);
                }

                dragAutomation
                    .run()
                    .catch(err => failIfActionElementIsInvisible(err, actionType, element))
                    .then(function () {
                        callback();
                    });
            });
        });
}

export function select () {
    var actionStarted       = false;
    var actionType          = 'select';
    var elements            = arguments[0] ? ensureArray(arguments[0]) : null;
    var args                = arrayUtils.from(arguments).slice(1);
    var firstArg            = args ? args[0] : null;
    var startNode           = null;
    var endNode             = null;
    var error               = false;
    var commonParentElement = null;

    if (!elements) {
        failWithError(ERROR_TYPE.incorrectSelectActionArguments);
        return;
    }

    if (firstArg && isJQueryObj(firstArg)) {
        if (firstArg.length < 1) {
            failWithError(ERROR_TYPE.incorrectSelectActionArguments);
            return;
        }
        else
            firstArg = firstArg[0];
    }

    // NOTE: the second action argument is a dom element or a text node
    if (args.length === 1 && (domUtils.isDomElement(firstArg) || domUtils.isTextNode(firstArg))) {
        if (styleUtils.isNotVisibleNode(firstArg)) {
            failWithError(ERROR_TYPE.incorrectSelectActionArguments);
            return;
        }

        startNode = isJQueryObj(elements[0]) ? elements[0][0] : elements[0];
        endNode   = firstArg;

        if (!domUtils.isContentEditableElement(startNode) || !domUtils.isContentEditableElement(endNode))
            error = true;
        else {
            // NOTE: We should find a common element for the nodes to perform the select action
            var commonParent = contentEditable.getNearestCommonAncestor(startNode, endNode);

            if (!commonParent)
                error = true;
            else {
                commonParentElement = domUtils.isTextNode(commonParent) ? commonParent.parentElement : commonParent;

                if (!commonParentElement)
                    error = true;
            }
        }
    }
    else
        error = arrayUtils.some(args, value => isNaN(parseInt(value)) || args.length > 1 && value < 0);

    if (error) {
        failWithError(ERROR_TYPE.incorrectSelectActionArguments);
        return;
    }

    stepIterator.asyncActionSeries(
        commonParentElement ? [commonParentElement] : elements,
        actionArgumentsIterator(actionType).run,
        function (element, callback, iframe) {
            ensureElementVisibility(element, actionType, function () {
                if (!actionStarted) {
                    actionStarted = true;
                    onTargetWaitingFinished();
                }

                var targetWindow     = iframe ? iframe.contentWindow : window;
                var automations      = getAutomations(targetWindow);
                var selectAutomation = null;

                if (startNode && endNode)
                    selectAutomation = new automations.SelectEditableContent(startNode, endNode, {});
                else {
                    var selectArgsObject     = getSelectAutomationArgumentsObject(element, args);
                    var { startPos, endPos } = calculateSelectTextArguments(element, selectArgsObject);

                    selectAutomation = new automations.SelectText(element, startPos, endPos, {});
                }

                selectAutomation
                    .run()
                    .catch(err => failIfActionElementIsInvisible(err, actionType, element))
                    .then(function () {
                        callback();
                    });
            });
        });
}

export function type (what, text, options) {
    if (!text) {
        failWithError(ERROR_TYPE.emptyTypeActionArgument);
        return;
    }

    var actionStarted = false;
    var actionType    = 'type';
    var elements      = ensureArray(what);

    stepIterator.asyncActionSeries(
        elements,
        actionArgumentsIterator(actionType).run,
        function (element, callback, iframe) {
            ensureElementVisibility(element, actionType, function () {
                if (!actionStarted) {
                    actionStarted = true;
                    onTargetWaitingFinished();
                }

                options = options || {};

                var { offsetX, offsetY } = getAutomationOffsetOptions(element, options.offsetX, options.offsetY);
                var typeOptions          = new TypeOptions({
                    offsetX,
                    offsetY,
                    caretPos: options.caretPos,
                    replace:  options.replace,

                    modifiers: options
                }, false);

                var targetWindow       = iframe ? iframe.contentWindow : window;
                var TypeAutomationCtor = getAutomations(targetWindow).Type;
                var typeAutomation     = new TypeAutomationCtor(element, text, typeOptions);

                typeAutomation
                    .run()
                    .catch(err => failIfActionElementIsInvisible(err, actionType, element))
                    .then(function () {
                        callback();
                    });
            });
        });
}

export function hover (what, options) {
    var actionStarted = false;
    var actionType    = 'hover';
    var elements      = ensureArray(what);

    stepIterator.asyncActionSeries(
        elements,
        actionArgumentsIterator(actionType).run,
        function (element, callback, iframe) {
            ensureElementVisibility(element, actionType, function () {
                if (!actionStarted) {
                    actionStarted = true;
                    onTargetWaitingFinished();
                }

                options = options || {};

                var { offsetX, offsetY } = getAutomationOffsetOptions(element, options.offsetX, options.offsetY);

                var hoverOptions = new MouseOptions({
                    offsetX,
                    offsetY,
                    modifiers: options
                }, false);

                var targetWindow        = iframe ? iframe.contentWindow : window;
                var HoverAutomationCtor = getAutomations(targetWindow).Hover;
                var hoverAutomation     = new HoverAutomationCtor(element, hoverOptions);

                hoverAutomation
                    .run()
                    .catch(err => failIfActionElementIsInvisible(err, actionType, element))
                    .then(function () {
                        callback();
                    });
            });
        });
}

export function press () {
    stepIterator.asyncActionSeries(
        arguments,
        pressActionArgumentsIterator().run,
        function (keySequence, callback) {
            var parsedKeySequence = parseKeySequence(keySequence);

            if (parsedKeySequence.error)
                failWithError(ERROR_TYPE.incorrectPressActionArgument);
            else {
                var PressAutomationCtor = getAutomations(window).Press;
                var pressAutomation     = new PressAutomationCtor(parsedKeySequence.combinations, {});

                pressAutomation
                    .run()
                    .then(function () {
                        callback();
                    });
            }
        });
}

//wait
var conditionIntervalId = null;

function startConditionCheck (condition, onConditionReached) {
    conditionIntervalId = nativeMethods.setInterval.call(window, function () {
        if (stepIterator.callWithSharedDataContext(condition))
            onConditionReached();
    }, CHECK_CONDITION_INTERVAL);
}

function stopConditionCheck () {
    if (conditionIntervalId !== null) {
        window.clearInterval(conditionIntervalId);
        conditionIntervalId = null;
    }
}

export function wait (ms, condition) {
    condition = typeof(condition) === 'function' ? condition : null;

    if (typeof ms !== 'number' || ms < 0) {
        failWithError(ERROR_TYPE.incorrectWaitActionMillisecondsArgument);
        return;
    }

    stepIterator.asyncAction(function (iteratorCallback) {
        function onConditionReached () {
            window.clearTimeout(timeout);
            stopConditionCheck();
            iteratorCallback();
        }

        var timeout = nativeMethods.setTimeout.call(window, onConditionReached, ms || 0);

        if (condition)
            startConditionCheck(condition, onConditionReached);
    });
}

export function waitFor (event, timeout) {
    var waitForElements = isStringOrStringArray(event, true),
        timeoutExceeded = false;

    if (typeof event !== 'function' && !waitForElements) {
        failWithError(ERROR_TYPE.incorrectWaitForActionEventArgument);
        return;
    }

    if (typeof timeout === 'undefined')
        timeout = WAIT_FOR_DEFAULT_TIMEOUT;

    if (typeof timeout !== 'number' || timeout < 0) {
        failWithError(ERROR_TYPE.incorrectWaitForActionTimeoutArgument);
        return;
    }

    onTargetWaitingStarted(true);

    stepIterator.asyncAction(function (iteratorCallback) {
        var timeoutID = nativeMethods.setTimeout.call(window, function () {
            if (waitForElements)
                stopConditionCheck();

            timeoutExceeded = true;
            failWithError(ERROR_TYPE.waitForActionTimeoutExceeded);
        }, timeout);

        function onConditionReached () {
            if (timeoutExceeded)
                return;

            if (waitForElements)
                stopConditionCheck();

            window.clearTimeout(timeoutID);
            onTargetWaitingFinished();
            iteratorCallback();
        }

        var condition = null;

        if (waitForElements) {
            if (typeof event === 'string') {
                condition = function () {
                    return !!sandboxedJQuery.jQuery(event).length;
                };
            }
            else {
                condition = function () {
                    var elementsExist = true;

                    for (var i = 0; i < event.length; i++) {
                        if (!sandboxedJQuery.jQuery(event[i]).length) {
                            elementsExist = false;
                            break;
                        }
                    }

                    return elementsExist;
                };
            }

            startConditionCheck(condition, onConditionReached);
        }
        else {
            stepIterator.callWithSharedDataContext(function () {
                event.call(this, function () {
                    onConditionReached();
                });
            });
        }
    });
}

export function navigateTo (url) {
    var NAVIGATION_DELAY = 1000;

    stepIterator.asyncAction(function (iteratorCallback) {
        hammerhead.navigateTo(url);

        //NOTE: give browser some time to navigate
        nativeMethods.setTimeout.call(window, iteratorCallback, NAVIGATION_DELAY);
    });
}

export function upload (what, path) {
    var actionStarted = false,
        elements      = ensureArray(what);

    if (!isStringOrStringArray(path) && path)
        failWithError(ERROR_TYPE.uploadInvalidFilePathArgument);

    stepIterator.asyncActionSeries(
        elements,
        actionArgumentsIterator('upload').run,
        function (element, callback) {
            if (!domUtils.isFileInput(element))
                failWithError(ERROR_TYPE.uploadElementIsNotFileInput);

            else {
                if (!actionStarted) {
                    actionStarted = true;
                    onTargetWaitingFinished();
                }

                var UploadAutomationCtor = getAutomations(window).Upload;
                var uploadAutomation     = new UploadAutomationCtor(element, path,
                    filePaths => failWithError(ERROR_TYPE.uploadCanNotFindFileToUpload, { filePaths })
                );

                uploadAutomation
                    .run()
                    .then(function () {
                        callback();
                    });
            }
        }
    );
}

export function screenshot (filePath) {
    stepIterator.asyncAction(function (iteratorCallback) {
        stepIterator.takeScreenshot(function () {
            iteratorCallback();
        }, filePath);
    });
}

//NOTE: published for tests purposes only
export function setElementAvailabilityWaitingTimeout (ms) {
    SETTINGS.get().SELECTOR_TIMEOUT = ms;
}

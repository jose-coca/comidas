/*jslint continue:true */
/*jslint plusplus: true */
/*global document, window, navigator, location, parent, self, console, screen */
/*global clearTimeout, setTimeout, Image */
/*global g_uemJsStarted, g_uemServerTime, g_uemHttpCode */

(function () {
    'use strict';

    // Functions needed for API compability
    // (Different EUEM versions running inside frames, so all RootObj.* has to be availbe in different compressed versions, with same names):
    // .GetParentObj
    // .SetCheckInQueue
    // .AsyncInit
    // .SetSetting / .GetSetting
    // .SetMetric / .GetMetric

    var jsst = 1 * new Date(), // Time that JavaScript started, used if global g_uemJsStarted or "w[on].jsst = 1 * new Date();" isen't set.
        w = window,
        d = document,
		pageLoad = 1, // Indicates that a full load of page occured where our script was loaded, after that it's only XHR status transitions.
        origXMLHttpRequest = w.XMLHttpRequest,
        b = {'chrome': false, 'ff': false, 'ie': false}, // Local var for browser settings, b.ie, b.ff, b.chrome.
        ua = navigator.userAgent.toLowerCase(), // Lowercase browser user-agent string for Browser detection.
        o = {
            id: 0,
            version: ['0000', '00', '00', 'CLOUD'],
            initialized: false,
            lb: '##\n',
            resultType: {
                unknown: 0,
                cookie: 1,
                performanceTimings: 2
            },
            methodType: {
                unknown: 0,
                page: 1,
                frame: 2,
                timeout: 3
            }
        };

    // Store this object as uxm_web.core, skip if already created.
    var globalObjectName = w['McgUxmObj'] || 'uxm_web';
    if (w[globalObjectName] && typeof(w[globalObjectName].core) != 'undefined') {
        console.log('WARNING: MCG UXM Web Agent exists multiple times on this page, is it injected incorrectly?');
        return;
    }
    
    // Settings: server, key, forceHttps, forceHttp, secureCookie, sendScreenSize,
    //		asyncWait, - Default: 1000 - How long to wait for subcalls, a user clicking a object will force the sending of the result.
    //		timeout, - Default: 600 - how many seconds to wait before dropping the measure.
    //		hookAspNet,
    //		hookAjax,
    //		captureFullQuery, - XHR/iFrame capture full url + query, can be very long.
    //		measureSubFrames,
    //		measureSubAjax,
    //		type = 'crm/mssp',	- Should we discard this and auto-detect via modules.
    //		timeout,
    //		ajaxSkipRegex
    o.settings = [];

    // Metrics measured:
    //   username, identifier, url, referenceURL, sessionId,
    //   requestStarted, jsStarted, domReady, onLoadReady, onAsyncEnded,
    //		tac, - Total XHR Calls
    //		tf,
    //      runningRequests, - Running Frames/XHR calls that we are waiting for.
    //		isapiServerTime, - From IIS ISAPI Filter.
    //		isapiHttpCode, - From IIS ISAPI Filter.
    //		last_click, -- Last identifier that the user clicked on.
    o.metrics = [];

    // Save list over subrequests. (Frames/XHR)
    // Each module appends to this. (Frame/XHR modules)
    o.subRequests = {};

    // Store list over timings.
    o.timings = {};

    // Error detection.
    o.jsErrors = [];
    o.previousOnError = null;

    // Callback functions for modules.
    //
    o.callbacks = {};

    // TODO: Cleanup ?
    o.exitCookieSet = false;
    o.firstAsyncCall = false;
    o.inAsyncWaitingState = false; // Waiting for new frames / XHR calls, click/onunload events will force the results to be send.
    o.timerId = 0;
    o.entry = true;

    // TODO: Cache Parent / RootObj so we don't have to look it up XX times.
    // o.cacheRootObj = null;

    // ASP.NET 2.0 postback hooking.
    // TODO: Move to own module and support ASP.NET 4.0 postback hooking.
    // o.oldPostBackForm = null;

    /**
     * Get current UTC microtime timestamp. (to measure response times)
     */
    o.GetMilliTimestamp = function () {
        return new Date().getTime();
    };

    /**
     * ParseBool - Tries to convert a string/null value into a boolean value.
     * null returns false.
     * 'true'|'TRUE'|'yes' returns true.
     * true returns true.
     */
    o.ParseBool = function (sValue) {
        if (sValue === true) {
            return true;
        }
        if (typeof sValue === 'string') {
            if (sValue.toLowerCase() === 'true' || sValue.toLowerCase() === 'yes') {
                return true;
            }
        }
        return false;
    };

    /**
     * GetSetting - Checks and return the setting name.
     * Supported settings: server, key, forceHttps, forceHttp, secureCookie, sendScreenSize, asyncWait, hookAspNet,, measureSubFrames, measureSubAjax, timeout, iframe.link.
     * Returned type can be empty, or bool to force Boolean value.
     */
    function GS(sSettingName, type) {
        var s = null;
        type = type || '';
        if (o.settings.hasOwnProperty(sSettingName)) {
            s = o.settings[sSettingName];
        }
        if (type === 'bool' || type === 'boolean') {
            s = o.ParseBool(s);
        }
        return s;
    }
    o.GetSetting = GS;

    /**
     *  GetSettingMetadataNames: Returns all the metadata names
     *  The result is an array containing the names of the metadata items
     
    function GSMN() {
        let result = [];
        let re = new RegExp("^metadata\.(?<metaDataName>.*)$");
        Object.keys(o.settings).forEach(function (settingKey){
            const match = settingKey.match(re);
            if(match && match.groups && match.groups.metaDataName)
                result.push(match.groups.metaDataName);
        });
        return result;
    }
    o.GetSettingMetadataNames = GSMN;
	*/

    /**
     * SetSetting - Sets the setting name to the supplied value.
     * Supported settings: server, key, forceHttps, forceHttp, secureCookie, sendScreenSize, asyncWait, hookAspNet,, measureSubFrames, measureSubAjax, timeout, iframe.link.
     */
    function SS(sSettingName, sValue) {
        o.settings[sSettingName] = sValue;
    }
    o.SetSetting = SS;

    o.OutputToConsole = function (msg, obj, type) {
        var doDebug = o.GetSetting('debug', 'bool');
        type = type || 'debug';
        if (typeof console !== 'undefined' && typeof console.log !== 'undefined') {
            var output = o.GetMilliTimestamp() + ' - UXM - ' + msg;
            if(type === 'debug' && console.debug && doDebug) console.debug(output);
            if(type === 'warn' && console.warn) console.warn(output);
            if(type === 'error' && console.error) console.error(output);
            if(type === 'info' && console.info) console.info(output);

            if (typeof console.dir !== 'undefined' && obj !== null && typeof obj !== 'undefined') {
                console.dir(obj);
            }
        }
    };

    //Used for writing logging text to console.
    // type: debug | warn | error.
    o.AddLogMsg = function (msg, obj, type) {
        // IE BHO includes this if IE8+, Installer script includes it in final build.
        o.OutputToConsole(o.id + " - " + msg, obj, type);
    };
	
    o.CalculateTiming = function(a, b, requireBothValues) {
        if (a == null || b == null || a === b) {
          return '';
        }

        // https://gitlab.saas.mcg.dk/mcg-uxm/uxmapp/-/issues/1241 - Require both values if Timing-Allow-Origin isn't set for external resources, could return incorrect calculations.
        if(requireBothValues === true && (a <= 0 || b <= 0)) {
            return 0;
        }

        // Calculate difference and only return if larger than 0.
        var diff = Math.round(a - b);
        if (diff < 0) {
          return '';
        }
        return diff;
    };
	
    o.CalculateTcpAndSsl = function(connectStart, connectEnd, secureConnectionStart){
        var tcp = 0;
        var ssl = 0;
        if (connectStart > 0 && connectEnd > 0) {
            // Only capture SSL if used.
            if (secureConnectionStart != null && secureConnectionStart > 0) {
                tcp = Math.round(secureConnectionStart - connectStart);
                ssl = Math.round(connectEnd - secureConnectionStart); 
            } else {
                tcp = Math.round(connectEnd - connectStart);
            }
        }

        return {tcp: tcp, ssl: ssl};
    };

    /**
     * GetParentObj - Returns the parent Window, if parent EUMJS agent exists and is correct version.
     * Returns null if no parent windows exists.
     *
     * TODO: Optimize/CacheParent ?, we call this a lot.
     */
    o.GetParentObj = function () {
        try {
            var p = parent,
                r = null,
                v;

            if (p && (p !== self) && (p[globalObjectName] && typeof(p[globalObjectName].core) != 'undefined')) {
                r = p[globalObjectName].core;
                if (r && r.version) {
                    // Versions after 535 has API compability.
                    // Use Version 201512140 to be sure functions matches, after we refactored code into modules.
                    v = parseInt(r.version.join(''), 10);
                    if (v >= 201512140 || v === parseInt(o.version.join(''), 10)) {
                        o.AddLogMsg('Parent version: ' + v + ', found.');
                        return r;
                    }
                }
            }
        } catch (err) {}

        return null;
    };

    /**
     * GetRootObj - Return the root EUMJS object, in case we have multiple Frames that link to each other Frame2 -> Frame1 -> MainPage (Root).
     * Returns null if we are the Root object.
     */
    o.GetRootObj = function (rootObj) {
        var enabled_link_iframes = GS('iframe.link');
        if(enabled_link_iframes !== "true")
            return null;
        var newRootObj;
        rootObj = rootObj || null;

        try {
            newRootObj = o.GetParentObj();
            if (newRootObj) {
                return newRootObj.GetRootObj(newRootObj);
            }
        } catch (err) {}

        // Avoid returning own object, just return null when we are root the object.
        return rootObj;
    };

    /**
     * GetMetric - Reurns the counter, uses the parent Window if any (If called from iFrame and bGetParent is true).
     * bGetRoot: Default false.
     */
    function GM(sMetricName, bGetRoot) {
        var c = null, pObj;
        bGetRoot = bGetRoot || false;

        // Return parent Window value. (If we are a Frame)
        if (bGetRoot) {
            pObj = o.GetRootObj();
            if (pObj) {
                return pObj.GetMetric(sMetricName, false);
            }
        }

        if (o.metrics.hasOwnProperty(sMetricName)) {
            c = o.metrics[sMetricName];
        }
        return c;
    }
    o.GetMetric = GM;

    /**
     * SetMetric - Sets the counter and updates the parent Window if any.
     * bUpdateParents: Default false.
     */
    function SM(sMetricName, sValue, bUpdateParents) {
        var pObj = o.GetParentObj();
        bUpdateParents = bUpdateParents || false;
        o.metrics[sMetricName] = sValue;

        // Update parent Window value. (If we are a Frame)
        if (pObj && bUpdateParents) {
            pObj.SetMetric(sMetricName, sValue, bUpdateParents);
        }
    }
    o.SetMetric = SM;

    /**
     * IncreaseMetric - Increase the counter and return the increased value.
     */
    function IM(sMetricName, value) {
        var c = GM(sMetricName, true) + value;
        SM(sMetricName, c, true);
        return c;
    }
    o.IncreaseMetric = IM;

    /**
     * Search for pattern in string and returns the found position. (-1 if not found)
     * @param searchStr to search in
     * @param pattern to search for
     * @returns position in string
     */
    function strpos(searchStr, pattern) {
        var pos = -1;
        if (searchStr && pattern) {
            pos = searchStr.indexOf(pattern);
        }
        return pos;
    }

    /**
     * TrimString/TS: Removes Left and Right whitespaces.
     */
    function TS(str, length) {
        str = str || "";
        length = length || 255;

        // Limit the length of the identifier.
        if (parseInt(length, 10) > 0) {
            str = str.substring(0, parseInt(length, 10));
        }

        str = str.replace(/^\s+|\s+$/g, "");

        // Remove single quotes '...' from the string.
        if (str.charAt(0) === "'") {
            str = str.slice(1);
            if (str.charAt(str.length - 1) === "'") {
                str = str.slice(0, str.length - 1);
            }

            str = str.replace(/^\s+|\s+$/g, "");
        }

        return str;
    }
    o.TrimString = TS;

    // 20180924 - New option is to use script initialization arguments stored under w[globalObjectName].iargs
    function ProcessCommand(args) {
        if(args.length >= 2) {
            SS(TS(args[0]+''), args[1]);
        }
    }

    if(w[globalObjectName] && typeof(w[globalObjectName].iargs) != 'undefined') {
        var iargs = w[globalObjectName].iargs;
        for(var i=0; i<iargs.length; i++) {
            ProcessCommand(iargs[i]);
        }
    }

    function addAfterInitializationSupport() {

        // Take out JSST and use it if set.
        if (w[globalObjectName] && typeof(w[globalObjectName].jsst) == 'number') {
            jsst = w[globalObjectName].jsst;
            o.AddLogMsg('Using object initilizers from async script loading: ' + jsst);
        }

        w[globalObjectName] = function () {
            ProcessCommand(arguments);
        };
        w[globalObjectName].core = o;
    }
    addAfterInitializationSupport();
    
    /**
     * Try to parse out the version of a string. (Returns 0 if not parsable)
     * @param searchStr to search in, eg. Chrome/47.0.2526.73
     * @param startPattern start tag to search for, eg. Chrome/.
     * @param length How many charactors to include, eg. 3 if maximum version length is 0-999, everything found after first . is discarded.
     * @returns version
     */
    function parseVersion(searchStr, startPattern, length) {
        var pos = strpos(searchStr, startPattern),
            v = 0;

        if (pos >= 0) {
            v = parseInt(searchStr.substr(pos + startPattern.length, length), 10);
        }
        return v;
    }

    // START: Get browser type and version.
    // Check with if(if b.ie && b.ie > 8).
    try {
        // http://www.useragentstring.com/

        if (strpos(ua, "chrome/") >= 0) {
            // Chrome: Mozilla/5.0 (Windows NT 6.1; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/47.0.2526.73 Safari/537.36
            b.chrome = parseVersion(ua, "chrome/", 4);

        } else if (strpos(ua, "firefox/") >= 0) {
            // mozilla/5.0 (windows; u; windows nt 5.1; da; rv:1.9.0.6) gecko/2009011913 firefox/3.0.6 (.net clr 3.5.30729)
            // Mozilla/5.0 (Windows NT 6.3; rv:36.0) Gecko/20100101 Firefox/36.0
            b.ff = parseVersion(ua, "firefox/", 4);

        } else if (strpos(ua, "msie") >= 0) {
            // IE: detection
            // IE 10.6 - Mozilla/5.0 (compatible; MSIE 10.6; Windows NT 6.1; Trident/5.0; InfoPath.2; SLCC1; .NET CLR 3.0.4506.2152; .NET CLR 3.5.30729; .NET CLR 2.0.50727) 3gpp-gba UNTRUSTED/1.0
            b.ie = parseVersion(ua, "msie", 4);

        } else if (strpos(ua, "rv:") >= 0) {
            // IE 11 - Mozilla/5.0 (Windows NT 6.1; WOW64; Trident/7.0; AS; rv:11.0) like Gecko
            b.ie = parseVersion(ua, "rv:", 4);
        }
    } catch (ex) {}

    /**
     * Return the detected browser in a object.
     * Check with if(if b.ie && b.ie > 8).
     */
    o.GetBrowser = function () {
        return b;
    };

    // END: Get browser type and version.

    /**
     * Reset - Restart the monitoring, override metrics and callback handlers.
     */
    o.Reset = function () {
        var id,
            m,
            key;

        for (key in o.metrics) {
            if (o.metrics.hasOwnProperty(key) &&
                key !== 'sid' &&
                key !== 'v' &&
                key !== 'resultsSend' &&
                key !== 'previousResources') {
                SM(key, null, false);
            }
        }

        //o.AddLogMsg('ResetVars (Maybe no frame ID yet)');
        o.exitCookieSet = false;
        if (o.timerId > 0) {
            clearTimeout(o.timerId);
        }
        o.timerId = 0;
        o.jsErrors = [];
        o.subRequests = {};
        o.timings = {};
        o.inAsyncWaitingState = false;
        o.firstAsyncCall = false;
    };

    /**
     * AttachEvent/AddEventListener to object and run handler callback when event occurs.
     * event = load, unload, beforeunload.
     */
    o.Attach = function (obj, event, handler) {
        if (b.ie && typeof obj.attachEvent !== 'undefined') {
            obj.attachEvent('on' + event, handler);

        } else if (typeof obj.addEventListener !== 'undefined') {
            obj.addEventListener(event, handler, false);
        }
    };

    // Start: DOM Loaded detection.

    /**
     * Called when DOM is ready, updates the domReady time if it's less than onLoad timer.
     */
    function onDomReady() {
        // Skip onDomReady if OnLoad already has executed.
        var onLoadReady = GM('onLoadReady') || 0,
            jsStarted = GM('jsStarted') || 0,
            resultsSend = GM('resultsSend') || 0;

        o.AddLogMsg('onDomReady onLoadReady: ' + onLoadReady);

        if (onLoadReady <= 0) {
            o.AddLogMsg('onDomReady: ' + o.CalcResponseTime(jsStarted) + ', resultsSend: ' + resultsSend + ', ReadyState: ' + o.GetReadyState(document) + ', URL: ' + o.GetLastURL());
            SM('domReady', o.GetMilliTimestamp());
            //o.WalkDomTree();
        }
    }

    /**
     * Called when Internet Explorer ready state changes, we uses this to detect when the DOM is ready. (ReadyState = loaded)
     * TODO: Is also called by hookIntoDOMContentLoaded, duplicate or leagacy for older IE versions??
     */
    function onIE_ReadyStateChanged() {
        o.AddLogMsg('onIE_ReadyStateChanged: ' + d.readyState);
        if (d.readyState === 'loaded') {
            onDomReady();
        }
        /* doc:rdy handles it.
		else if (d.readyState == 'interactive' && o.domReady <= 0) {
		onDomReady();
		}
		else if (d.readyState === 'complete') {
			// o.onLoadEvent();
		}*/
    }

    // Hook into DOMContentLoaded | ReadyState = loaded.
    function hookIntoDOMContentLoaded() {
        if (b.ie) {
            (function () {
                var rdy = d.createElement('doc:rdy');
                try {
                    rdy.doScroll('left');
                    rdy = null;
                    o.AddLogMsg('hookIntoDOMContentLoaded doc:rdy now');
                    onDomReady();

                } catch (e) {
                    // Retry if exception occured.
                    setTimeout(hookIntoDOMContentLoaded, 5);
                }
            }());
        } else if (typeof d.addEventListener !== 'undefined') {
            d.addEventListener('DOMContentLoaded', function () {
                onDomReady();
            }, false);
        }
    }

    // End: DOM Loaded detection.

    /**
     * sEvent:
     *      checkIfDone - Executed every 1 second to see if page is completely loaded. (Plugins checks for iFrame/XHR calls still running)
     *      getUsername - Executed before data is send, used to parse username out from JavaScript object or HTML DOM.
     *
     * Remember to Unsubscribe from the callbacks added.
     *
     * apm.Subscribe('checkIfDone', checkIfAllXhrCallsAreFinished);
     * apm.Subscribe('beforeSendResults', gatherUsernameBeforeSendingResults);
     */
    o.Subscribe = function (sEvent, callbackFunc) {
        var r = o.GetRootObj() || o;
        if (r.callbacks.hasOwnProperty(sEvent)) {
            r.callbacks[sEvent].push(callbackFunc);

        } else {
            r.callbacks[sEvent] = [callbackFunc];
        }
    };

    /**
     * Unsubscribe callback function from sEvent, to avoid iframes filling up the callbacks array.
     * IE Exception - Can't execute code from a freed script when frame doesn't free it's handle, 
     *
     * apm.Attach(window, 'unload', function () {
     *    apm.Unsubscribe('beforeSendResults', gatherUsernameBeforeSendingResults);
     * });
     */
    o.Unsubscribe = function (sEvent, callbackFunc) {
        var r = o.GetRootObj() || o,
            arr,
            i;

        if (r.callbacks.hasOwnProperty(sEvent)) {
            arr = r.callbacks[sEvent];
            for (i = 0; i < arr.length; ++i) {
                if (arr[i] === callbackFunc) {
                    arr.splice(i--, 1);
                }
            }
        }
    };

    /// Calculations Date/ResponseTime:

    /**
     * Convert Local DateTime to UTC.
	 * Warning .getTime is already in UTC timezone, so don't double adjust it.
     * d: Date object.
       Skipped all timings is returned as UTC.
    o.AdjustDateToUTC = function (d) {
        return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds());
    };*/

    /**
     * Convert Millisecond Timestamp to UTC Date.
	 * Used by NavTimings script.
       Skipped all timings is returned as UTC.
    o.ConvertTimestampToUTC = function (msTs) {
        // Only convert if over Zero.
        if (msTs <= 0) return 0;

        var dt = new Date();
        dt.setTime(msTs);
        return o.AdjustDateToUTC(dt).getTime();
    };*/

    /**
     * Calculate the difference between the starttime and now.
     */
    o.CalcResponseTime = function (startTime) {
        return o.GetMilliTimestamp() - startTime;
    };

    /**
     * Calculate the difference between endTime and startTime arguments.
     */
    o.CalcDuration = function (endTime, startTime) {
        return Math.max(0, parseInt(endTime - startTime, 10));
    };

    // End Calculations Date/ResponseTime.

    /**
     * TODO: What are we doing here, cleanup/document and make more logical.
     * I think it was added when clicking on button that did XHR calls without re-loading the whole page, we need to reset/set start times correctly.
     * It's beeing called from the apm_eumjs_basicxhr script.
     */
    o.AsyncInit = function (msTs, id) {
        var rObj = o.GetRootObj(),
            requestStarted = GM('requestStarted') || GM('jsStarted'),
            timeout = GS('timeout') || 600,
            diff;

        // Run the parent root EUMJS function.
        if (o.IsFrameOfEumJs() && rObj) {
            return rObj.AsyncInit(msTs, id);
        }

        // The OnDomClick always sets this request started, so how can we avoid issues.
        // Maybe only allow 100 ms differences in the request started if jsStarted.
        // msTs = o.GetMilliTimestamp();
        diff = Math.abs(msTs - requestStarted);
        o.AddLogMsg('AsyncInit diff: ' + diff + ', requestStarted: ' + requestStarted + ", GM('requestStarted'): " + GM('requestStarted') + ", GM('requestStarted', true): " + GM('requestStarted', true));

        if (diff > (timeout * 1000) || (id <= 1 && o.entry === false)) {
            o.AddLogMsg('AsyncInit: Setting requestStarted to: ' + msTs + ', difference was > ' + (timeout * 1000) + ' ms or XHR/frame id is <= 1 and entry false.');

            // Store if it's the first XHR call, OnDocClick tries to send the results too fast when resultsSend = false.
            o.firstAsyncCall = true;

            // Override started values.
            o.AddLogMsg('AsyncInit, setting requestStarted to: ' + msTs);
            SM('requestStarted', parseInt(msTs, 10), true);

            // Force the Root EUMJS object to check if results should be send.
            // This is also called by frames that are updated when cliking on buttons after whole page have loaded.
            (rObj || o).SetCheckInQueue();

        } else {
            o.firstAsyncCall = false;
        }
    };

    /**
     * Validate numbers.
     */
    o.AnalyseBrowserPerformance = function () {

        // Extract info from modern browsers from the window.performance object.
        var jsStarted = GM('jsStarted'),
            requestStarted = GM('requestStarted') || jsStarted,
            domReady = GM('domReady'),
            onAsyncEnded = GM('onAsyncEnded'),
            isapiServerTime = GM('isapiServerTime');

        // Check if it's a frame or XHR call
        // TODO: Move to Frame module.
        if (o.IsFrameOfEumJs()) {
            SM('m', o.methodType.frame);
        }

        // Determine the ServerTime, DomTime, BrowserTime and TotalTime.
        // if (isapiServerTime > 0) { SM('st', Math.max(GM('st'), isapiServerTime)); }
        if (jsStarted > 0) { SM('st', jsStarted); }

        //apm.AddLogMsg('AnalyseBrowserPerformance: requestStarted: ' + requestStarted + ', onAsyncEnded: ' + o.onAsyncEnded + ', jsStarted: ' + o.jsStarted + ', domReady: ' + o.domReady + ', onAsyncEnded: ' + o.onAsyncEnded);

        // Calculate Dom/Browser times. Dom+Browser = Page Render Time.
        /*if (onAsyncEnded > 0 && jsStarted > 0) {
            if (domReady && domReady > 0) {
                // Use DomReady if it's set.
                SM('dt', o.CalcDuration(domReady, jsStarted));
                SM('bt', o.CalcDuration(onAsyncEnded, domReady));
            } else {
                // No DomReady time found so using the JS started time.
                SM('bt', o.CalcDuration(onAsyncEnded, jsStarted));
            }
        }*/

        if (onAsyncEnded > 0 && requestStarted > 0) {
            SM('st', requestStarted);
            SM('tt', o.CalcDuration(onAsyncEnded, requestStarted));
        }

        // Total time has to be > (Server Time + Browser Time + DomReady Time), notify us if it isen't by setting TotalTimeToLow (tttl).
        /*if (GM('tt') < (GM('st') + GM('dt') + GM('bt'))) {
            SM('tttl', 1, true);
            SM('tt', Math.max(GM('tt'), (GM('st') + GM('dt') + GM('bt'))));
        }*/

        // Try to determine the size of the http document.
        SM('ps', o.GetPageSize());
        o.AddLogMsg('AnalyseBrowserPerformance: TT: ' + GM('tt') + ', Size: ' + GM('ps') + ', onAsyncEnded: ' + onAsyncEnded + ', jsStarted: ' + jsStarted + ', requestStarted: ' + requestStarted);
    };

    /**
     * Tries to detect how many bytes the document is by using document.body.innerHTML.length.
     */
    o.GetPageSize = function () {
        var size = 0;
        try {
            size += d.body.innerHTML.length;
            size += (d.head ? d.head.innerHTML.length : d.getElementsByTagName("head")[0].innerHTML.length);
        } catch (ex) {
            o.OnError("WARNING: Couldn't find the document size: " + o.GetExceptionError(ex), '', 0);
            return size;
        }
        return size;
    };

    /**
     * Returns the current loaded URL.
     */
    o.GetURL = function () {
        var url = '';
        if (window && window.location) { url = window.location.href; }
        return url;
    };

    o.GetUrlWithoutCurrentPath = function (sURL) {
        try {
		    // BUG: Invalid urls are generated only remove FQDN or currentPath and take extract care if loaded from multiple ports.
            sURL = sURL.split("#")['0']; // Remove last # part.
            sURL = sURL.split("?")['0']; // Remove last ? part.
        } catch(error){
        }
        return sURL;
    };

    o.GetUrlWithoutHash = function (sURL) {
        try {
            sURL = sURL.split("#")['0']; // Remove last # part.
        } catch(error){
        }
        return sURL;
    };

    /**
     * Returns the last part of the URL after '/'.
     */
    o.GetLastURL = function (sURL) {
        sURL = sURL || o.GetURL();
        var shortUrl;

        shortUrl = sURL.split("#")['0']; // Remove last # part.
        shortUrl = shortUrl.split("?")['0']; // Remove last ? part.
        shortUrl = shortUrl.split("/"); // Get last text after /.

        if (shortUrl.length > 0) {
            return "/" + shortUrl[shortUrl.length - 1];
        }
        return "/";
    };

    /**
     * Returns the title of the page.
     */
    o.GetTitle = function () {
        return TS(d.title, 100);
    };

    /**
     * Create new 1x1 img that sends the results async.
     * Should we remove these images if it's the same Angular/CRM page that dosn't change. (Using new Image instaed, so it only referenced in memory)
     * TODO: Limit on Apache is 8KB header, IIS is 16KB, increase of ensure that we are under the limit. (Using XHR post in future versions)
     */
    function sendResultViaImage(pathWithQueryData) {
        //var img = d.createElement('img');
        var img = new Image();
        img.src = pathWithQueryData;
    }

    /**
     * Execute the array of function callbacks and returns false when the first callback returns false.
     * Returns true if all callbacks returned true.
     *
     * Used to check if XHR calls is done loading and to gather username / nav timings.
     */
    function executeCallbacks(callbacksFuncs) {
        var ret, idx, obj;

        if (callbacksFuncs) {
            ret = true;
            for (idx in callbacksFuncs) {
                if (callbacksFuncs.hasOwnProperty(idx)) {
                    try {
                        obj = callbacksFuncs[idx];
                        if (typeof obj === 'function' || typeof obj === 'object') {
                            ret = obj();
                            if (!ret) {
                                return false;
                            }
                        }
                    } catch (e) {}
                }
            }
        }
        return true;
    }

    o.CollectTimings = function () {
        var timings = [],
            item,
			identifiers = GM('i') || '',
            count = 0,
            p,
            jsonObj,
            arr = [],
            headers,
            requestStarted = GM('requestStarted') || GM('jsStarted'),
            xhrCaptureMax = parseInt(GS('xhr.capture.max') || 25, 10);

        Object.keys(o.timings).forEach(function (key) {
            item = o.timings[key];
            timings.push(item);
        });

        Object.keys(o.subRequests).forEach(function (key) {
            item = o.subRequests[key];
            //item.url = o.GetUrlWithoutCurrentPath(item.url); // this code doesn't make sense if we need to replace query parameters
            item.url = o.GetUrlWithoutHash(item.url); // remove hash, it can potentially change between different calls to the same resource
            count += 1;

            /*if (item.type === 'frame' && count <= subrequestsCaptureMax) {
                timings.push(item.requestStarted + '|' + item.type + '|' +
                    item.dns + '|' + item.rdt + '|' + item.con + '|' + item.st + '|' + item.dl + '|' + item.tt + '|' +
                    item.url.replace(/|/g, '') + '|' + item.title.replace(/|/g, ''));
            } else */

            if ((item.type === 'xhr' || item.type === 'fetch') && count <= xhrCaptureMax) {

                if (item.type === 'fetch') {
                    // TODO - start with full url including query parameters:
                    // Example: https://fqdn/navi/controller/__builtin__/alerts?__options__=reqid=48&role=cur-tms-plan&intv=60
                    // Multiple could be returned, for example: https://fqdn/navi/controller/__builtin__/ping? returns 30 
                    //   TODO: Can we find correct one or should we take based on when it was executed +/- 5 seconds?
                    var _performanceEntries = window.performance.getEntriesByName(item.url);

                    // If entry not found, then try with Full URL
                    if (_performanceEntries.length === 0) {
                        _performanceEntries = window.performance.getEntriesByName(item.fullUrl);
                    }
                    if (_performanceEntries.length > 0) {
                        var _decodedBodySize = _performanceEntries[0].decodedBodySize;
                        if (_decodedBodySize){
                            item.ps = _decodedBodySize;
                        }
                    }
                }

				// Store first XHR call in identifiers data.
				if(count <= 1 && identifiers.length <= 0) {
					SM('i', JSON.stringify({"first_xhr_call": o.GetLastURL(item.url)}));
				}
				else if(count <= 1 && identifiers.length > 0 && (identifiers[0] == '{' || identifiers[0] == '[')) {
					try {
						jsonObj = JSON.parse(identifiers);
						jsonObj["first_xhr_call"] = o.GetLastURL(item.url);
						SM('i', JSON.stringify(jsonObj));
					} catch (eip) {
						o.AddLogMsg('Exception settings first_xhr_call: ' + eip, eip, 'error');
					}
                }

                arr = [(item.start - requestStarted), item.duration, item.method, item.status, item.async,
                    item.correlationtoken, item.ps, item.tf, item.tp, item.tcc];

                jsonObj = {};
                if (item.type === 'xhr'){
                    jsonObj[item.url] = {'x': arr.join('|'), 'h': item.headers};
                } else { // Fetch
                    jsonObj[item.url] = {'f': arr.join('|'), 'h': item.headers};
                }

                timings.push(jsonObj);
            }
        });
        return timings;
    }

    // Set username if set by settings uxm_web('username', func/string)
    /* Example:
    uxm_web('username', function() {
        if(typeof Xrm !== 'undefined' && Xrm.Page && Xrm.Page.context) {
            return Xrm.Page.context.getUserName();
        }
    });
    */
    o.GatherUsername = function() {
        var username = GS('username');
        if (typeof username === 'string') {
            SM('un', username);
        }
        else if (typeof username === 'function') {
            try {
                SM('un', username());
            } catch(une) {
                o.AddLogMsg('Exception getting username: ' + une, une, 'error');
            }
        }
    }

    // Generate the data to send and GET it via img element.
    o.SendResults = function (method, url) {
        var protocol = d.location.protocol,
            server = GS('server'),
            isPlugin = GS('isPlugin', 'bool'),
            traceId = GS('trace.id'),
            key,
            username,
            xhrData = {},
            bulkData = {};

        if (protocol !== 'http:' && protocol !== 'https:') {
            protocol = 'http:';
        }

        // Use https if it's forced. (People can have load balancers before their servers or want the extra security).
        if (GS('forceHttp', 'bool')) { protocol = 'http:'; }
        else if (GS('forceHttps', 'bool') || true) { protocol = 'https:'; }

        // Stop if TotalTime is <= 0.
        if (GM('tt') <= 0) {
            o.AddLogMsg("Sending results skipped, TT is <= 0\n");
            return false;
        }

        // Gather extra content information from CRM, SharePoint, Custom apps like username.
        // Gather Navigation timings and frame response times.
        if (!executeCallbacks(o.callbacks.beforeSendResults)) {
            //return o.SetCheckInQueue();
            // o.Reset(); is called afterwards and stops this sendResults from being called again.
        }

        // IE BHO sets isPlugin setting, so tell controller that we are a browser plugin.
        if (isPlugin) {
            SM('p', 1);
        }

        // Send default values.
		bulkData['pl'] = pageLoad;
        SM('t', o.GetTitle());
        SM('url', url);
        SM('m', method);
        SM('ref', d.referrer);
        if (!GM('rt')) { SM('rt', o.resultType.cookie); }

		// Set to 0 to indicate that next results are XHR status transitions.
		pageLoad = 0;
		
        var reportingServer = protocol + '//' + server + '/data/browser/';

        // Set username if set by settings uxm_web('username', func/string)
        o.GatherUsername();

        // Create object to send to collection server.
        xhrData = {key: GS('key') || window.location.host,
            sid: GM('sid'),
            version: o.version.join(''),
            data: []
        };

		// IE plugin sets the machine_uuid setting.
		if(GS('machine_uuid')) {
			xhrData.hostname = GS('hostname');
			xhrData.machine_uuid = GS('machine_uuid');
			xhrData.node_key = GS('node_key');
			xhrData.session_id = GS('host_session_id');
			xhrData.username = GS('username');
		}

        if (GS('sendScreenSize', 'bool') || GS('screensize.capture', 'bool') === true) {
           xhrData.screen = screen.width + '|' + screen.height + '|' + screen.colorDepth;
        }

        // Override TraceID if it's set in UXM Web JavaScript settings.
        if (traceId !== null) {
            SM('tid', traceId);
        }

        // Send JavaScript errors.
        bulkData['jse'] = JSON.stringify(o.jsErrors);

        // Send the XHR/Frames subrequests so we can make BT's on them and investigate why the page is slow.
        // TODO: Sort and only take top slowest out (But what if we are using subrequest for creating rule?)
		// 2018 - Filtering on subrequests has been removed in Splunk/UXM version, send first xhr call in identifier to allow creation of rules.
        bulkData['timings'] = o.CollectTimings();
        bulkData['timing_count'] = Math.max(GM('tac'), bulkData['timings'].length);
		
		var network_timings = GM('network_timings');       
        if (network_timings){
            bulkData['effectiveType'] = network_timings.effectiveType;
            bulkData['downlink'] = network_timings.downlink;
            bulkData['rtt'] = network_timings.rtt;
        }

        // Add all our metrics, that are under 5 charactors in length.
        for (key in o.metrics) {
            if (o.metrics.hasOwnProperty(key)) {
                if (key.length <= 5 && key !== 'sid' && key !== '' && GM(key)) {
                    bulkData[key] = GM(key);
                }
            }
        }

        /*let metaDataSettingNames = GSMN();
        let metadata = [];
        metaDataSettingNames.forEach(function(metadataName){
            let metadataValue = GS("metadata." + metadataName);
            if(metadataValue)
                metadata.push({[metadataName]: metadataValue});
        });
        if(metadata.length > 0)
            bulkData["metadata"] = metadata;*/
		
		// Send data to our UXM server.
        xhrData.data.push(bulkData);

        if(origXMLHttpRequest) {
            var xhr = new origXMLHttpRequest();
            xhr.open('POST', reportingServer, true);
            xhr.setRequestHeader('Content-type', 'application/json;charset=UTF-8');
            xhr.responseType = 'text';
            xhr.timeout = 10000;
            xhr.send(JSON.stringify(xhrData));
        }

        o.AddLogMsg('Results Send - TT: ' + GM('tt') + ", Type: " + GM('rt') + ', identifier: ' + GM('i'), null, 'info');

        SM('resultsSend', true);
        return true;
    };

    /**
     * ReadyState is undefined in browser that doesn't support readyState, FF3.0.6
     */
    o.GetReadyState = function (obj) {
        if (obj && obj.readyState) {
            return obj.readyState;
        }
        return '';
    };

    /**
     * Parse out the exception message from the exception, IE has it under e.message, FF/Chrome just sends the exception as a string.
     * TODO: Move to Error module ??
     */
    o.GetExceptionError = function (e) {
        var t = typeof e;
        if (t === 'string') {
            return e;

        }

        if (t === 'function' || t === 'object') {
            if (typeof e.message !== 'undefined') {
                return e.message;
            }
        }
        return e;
    };

    /**
     * Check if we are a frame and the parent window has a MCG APM EUMJS object.
     * use try/catch block to avoid cross domain errors.
     */
    o.IsFrameOfEumJs = function () {
        try {
            var p = parent;
            if (p && p !== self) {
                if (p[globalObjectName] && typeof(p[globalObjectName].core) != 'undefined') {
                    o.AddLogMsg('IsFrameOfEumJs returned true.');
                    return true;
                }
            }
        } catch (e) {}
        return false;
    };

    /**
     * Called every 1 second to check if everything is done.
     * Modules like XHR and Frame can extend this check by using apm.Subscripe('checkIfDone').
     */
    o.CheckIfPageIsCompletelyDone = function () {
        var readyState = o.GetReadyState(document),
            runningRequests = GM('runningRequests') || 0,
            xhrCalls = GM('tac') || 0,
            frames = GM('tf') || 0,
            idx,
            obj,
            done;

        o.AddLogMsg('CheckIfPageIsCompletelyDone: IsFrameOfEumJs: ' + o.IsFrameOfEumJs() + ', resultsSend: ' + GM('resultsSend') + ', ReadyState: ' + readyState + ', URL: ' + o.GetLastURL());

        // Only continue if readyState is empty or done (Undefined in browser that doesn't support readyState, FF3.0.6).
        if (readyState !== 'complete' && readyState !== '') {
            return o.SetCheckInQueue();
        }

        // Check if modules/plugins thinks the page is fully loaded.
        if (!executeCallbacks(o.callbacks.checkIfDone)) {
            return o.SetCheckInQueue();
        }

        // Reset everything if timeout is reached.
        var jsStarted = GM('jsStarted') || 0,
            requestStarted = GM('requestStarted') || jsStarted,
            onAsyncEnded = GM('onAsyncEnded') || 0,
            resultsSend = GM('resultsSend') || false,
            timeout = GS('timeout') || 600,
            started,
            duration,
            asyncDiff,
            xhrMinWaitTime = GS('xhrMinWaitTime') || GS('ajaxMinWaitTime') || GS('xhr.minWaitTime') || 850;

        duration = o.CalcResponseTime(requestStarted);
        asyncDiff = o.CalcResponseTime(onAsyncEnded);
        o.AddLogMsg('CheckIfPageIsCompletelyDone: duration: ' + duration + ',  jsStarted: ' + jsStarted + ', requestStarted: ' + requestStarted + ', asyncDiff: ' + asyncDiff);

        if (onAsyncEnded <= 0) {
            // Skip if no end was found. (Async reqests are running).
            o.AddLogMsg('CheckIfPageIsCompletelyDone: Skipped sending of results, onAsyncEnded is <= 0.');
            o.SetCheckInQueue();

        } else if (onAsyncEnded > 0 && asyncDiff <= xhrMinWaitTime) {
            // Wait for 850 ms after Async results are done, to ensure no new XHR/iFrame calls are executed.
            o.AddLogMsg('CheckIfPageIsCompletelyDone: Skipped sending of results, asyncDiff is <= ' + xhrMinWaitTime + ' ms.');
            o.SetCheckInQueue();

        } else if (resultsSend === false) {

            // Wait for more results if we are in a async waiting state.
            if (o.inAsyncWaitingState) {
                o.AddLogMsg('CheckIfPageIsCompletelyDone: We are in inAsyncWaitingState until 1 second without activity has occured or a mouse click.');
                o.inAsyncWaitingState = false;
                o.SetCheckInQueue();

            } else {
                // Check if we have the correct start time in the browser and Send the results to the UEM server.
                o.AnalyseBrowserPerformance();
                o.SendResults(o.methodType.page, o.GetURL());

                // Reset stats, if the user clicks buttons that updates the frames or makes XHR calls.
                o.Reset();

                //  What is entry used for??
                o.entry = false;
            }
        } else if (duration > (timeout * 1000)) {
            o.AddLogMsg('Send results and Reset because timeout is reached: ' + duration);

            // Check if we have the correct start time in the browser and Send the results to the UEM server.
            o.SendResults(o.methodType.timeout, o.GetURL());
            o.Reset();

        } else if (!resultsSend) {
            // Check again in X secounds.
            o.SetCheckInQueue();
        }
    };

    o.SetCheckInQueue = function (runImmediately) {
        runImmediately = runImmediately || false;

        // First clear the timeout, or else it can be called recursive.
        if (o.timerId > 0) {
            clearTimeout(o.timerId);
            o.timerId = 0;
        }

        if (runImmediately) {
            o.CheckIfPageIsCompletelyDone();
        } else {
            var asyncWait = GS('asyncWait') || 1000;
            o.timerId = setTimeout(o.CheckIfPageIsCompletelyDone, asyncWait);
        }
    };

    /***
     * Called when page is loaded and window.load is called.
     * Starts timer that checks every 1000 ms, if XHR/Frames are done loading.
     */
    function onLoadEvent() {
        var domReady = GM('domReady') || 0,
            resultsSend = GM('resultsSend') || 0,
            onLoadReady = o.GetMilliTimestamp(),
            rObj = o.GetRootObj() || o;

        o.AddLogMsg('OnLoad: ' + o.CalcResponseTime(domReady) + ', resultsSend: ' + resultsSend + ', ReadyState: ' + o.GetReadyState(document) + ', URL: ' + o.GetLastURL());
        o.exitCookieSet = false;

        // Calculate the Browser time (Render, Download of JS/IMG,XHR,etc).
        SM('onLoadReady', onLoadReady, true);
        SM('onAsyncEnded', onLoadReady, true);

        // Force the Root EUMJS object to check if results should be send.
        // This is also called by frames that are updated when cliking on buttons after whole page have loaded.
        rObj.SetCheckInQueue();
    }

    /**
     * Trace when the user leaves the page so we get the total response time (Network + Server + Page Loading).
     * FireFox / IE uses OnBeforeUnloadEvent when it fetches the next page. (OnUnLoadEvent is called when there is data ready).
     */
    function OnBeforeUnLoadEvent() {
        o.SetLeaveCookie();
    }

    /**
     * Opera only uses OnUnloadEvent, so set the cookie here.
     */
    function OnUnLoadEvent() {
        // Save an cookie with when we left the page, so we can get the total page loading time, from Click to next page done.
        if (!o.exitCookieSet) {
            o.SetLeaveCookie();
        }
    }

    // START: Cookie/sessionStorage support.
    // We need to use cookies or sessionStorage to store whhat/when a user click on a object.
    // PerformanceAPI only works for Full page loads, updating via XHR/Frames dosn't change the PerformanceAPI metrics.
    // 
    // sessionStorage: Opening a page in a new tab or window will cause a new session to be initiated with the value of the top-level browsing context, which differs from how session cookies work.
    //
    o.SetCookie = function (name, value, expires, path, domain) {
        // set time, it's in milliseconds
        var today = 1 * new Date(),
            expires_date,
            storageSession = GS('storage') || 'session',
            secure = (window.location.protocol === "https:");

        if (storageSession == 'session' && typeof sessionStorage !== 'undefined') {
            try {
                if(value == "") sessionStorage.removeItem(name, value);
                else sessionStorage.setItem(name, value);
                return;
            }
            catch(e) {}
        }

        /*
		if the expires variable is set, make the correct expires time, the current script below will set
        it for x number of days, 
         to make it for hours: expires * 24
         for minutes: expires * 60 * 24
		 */
        if (expires) {
            expires = expires * 1000 * 60;
        }

        // Override Secure Cookie if it's set.
        if(GS('secureCookie') !== null) {
            secure = GS('secureCookie', 'bool');
        }

        expires_date = new Date(today + (expires));
        d.cookie = name + "=" + encodeURIComponent(value) +
            ((expires) ? ";expires=" + expires_date.toGMTString() : "") +
            ((path) ? ";path=" + path : "") +
            ((domain) ? ";domain=" + domain : "") +
            ((secure) ? ";secure" : "");
    };

    /**
     * Save an cookie with when we left the page, so we can get the total page loading time, from Click to next page done.
     * We override with the PerformanceAPI timings if they exists.
     * We also need to do some validation if a user leaves the page and then comes back, then the cookie might be used incorrectly.
     */
    o.SetLeaveCookie = function () {
        var msTs = o.GetMilliTimestamp();

        o.AddLogMsg('SetLeaveCookie: ' + o.GetURL() + ', mts: ' + msTs + ', resultsSend: ' + GM('resultsSend'));

        // Check if the results are send, if not send them. (Check if we are a frame and are not supposed to send the results).
        o.inAsyncWaitingState = false;

        // Update the rootObj starttime if we are a frame.
        SM('requestStarted', msTs, true);

        o.SetCookie('uxm_web_prt', msTs, 1, '/', '');
        o.SetCookie('uxm_web_refurl', d.location, 1, '/', '');
        o.exitCookieSet = true;

        // Dehook the error handler.
        // TODO: Move to own module.
        window.onerror = o.previousOnError;
    };

    o.GenerateNewSessionId = function () {
        var chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXTZabcdefghiklmnopqrstuvwxyz",
            len = 25,
            sid = '',
            i,
            rnum;

        for (i = 0; i < len; i++) {
            rnum = Math.floor(Math.random() * chars.length);
            sid += chars.substring(rnum, rnum + 1);
        }

        // Store new session id in script and cookie that lasts until browser closes.
        SM('sid', sid, true);
        o.SetCookie('uxm_web_session', sid, 0, '/', '');
    };

    /**
     * Check if we have an cookie with the start time of this action and identifier clicked.
     */
    function parseRequestStartTimeCookie() {
        var i,
            decode = decodeURIComponent,
            storage = [],
            loadedFromSessionStorage = false,
            key,
            parm,
            diff,
            timeout = GM('timeout') || 600,
            requestStarted,
            identifier;

        if (typeof sessionStorage !== 'undefined') {
            try {
                storage.push("uxm_web_prt="+(sessionStorage.getItem('uxm_web_prt')||''));
                storage.push("uxm_web_refurl="+(sessionStorage.getItem('uxm_web_refurl')||''));
                storage.push("uxm_web_session="+(sessionStorage.getItem('uxm_web_session')||''));
                storage.push("uxm_web_tag="+(sessionStorage.getItem('uxm_web_tag')||''));
                loadedFromSessionStorage = true;
            }
            catch(e) {}
        }

        if(!loadedFromSessionStorage) {
            storage = d.cookie.split(";");
        }

        for (i = 0; i < storage.length; i++) {
            key = storage[i].substr(0, storage[i].indexOf("="));
            parm = storage[i].substr(storage[i].indexOf("=") + 1);
            key = key.replace(/^\s+|\s+$/g, "");

            if (key === "uxm_web_tag" && parm !== '') {
                SM('i', TS(decode(parm)), false);

            } else if (key === "uxm_web_refurl" && parm !== '') {
                SM('ref', TS(decode(parm)), false);
                o.AddLogMsg("Cookie parsed referenceURL: " + GM('ref'));

            } else if (key === "uxm_web_session" && parm !== '') {
                SM('sid', TS(decode(parm)), true);

            } else if (key === "uxm_web_prt" && parseInt(parm, 10) > 0) {
                // Ensure that we are not over our o.timeout time.
                var leaveCookieTime = parseInt(parm, 10);
                diff = Math.abs(o.GetMilliTimestamp() - leaveCookieTime);

                o.AddLogMsg('leaveCookie detection: ' + diff + ' < timeout: ' + (timeout * 1000) + ', leaveCookieTime (not used): ' + leaveCookieTime);

                // Only use the start time if it's under our maximum.
                // TODO: User could browse away from site and return again, causing a very high false response time.
                if (diff < (timeout * 1000)) {
                    // TODO: Don't use it, can be so misleading, use JSStarted time instead.
                    //o.AddLogMsg('Using cookie startTime in requestStarted: ' + leaveCookieTime);
                    //SM('requestStarted', leaveCookieTime);

                    // Always send cookie start time, PerformanceAPI doesn't match our total time.
                    SM('cokrs', leaveCookieTime);
                }
            }
        }

        // DEBUG:
        /*requestStarted = parseInt(GM('requestStarted')||0, 10);
        identifier = GM('i');

        if (requestStarted > 0 || identifier !== '') {
            o.AddLogMsg("Cookies parsed, RequestStarted: " + requestStarted + ", Identifier: " + identifier);
        }*/

        // TODO: Timeout the cookie after 30 minutes of inactivity.
        // We have to support New user and Revisiting users also, maybe reset the SessionID if user has been away for to long time.

        // Create a new SessioId if none exists.
        if (!GM('sid') || GM('sid') === '') {
            o.GenerateNewSessionId();
        }

        // Clear our tracing cookies again. (IE had a strange issue where it took an old cookie)
        o.SetCookie('uxm_web_tag', '', 1, '/', '');
        o.SetCookie('uxm_web_prt', '', 1, '/', '');
        o.SetCookie('uxm_web_refurl', '', 1, '/', '');
        SM('resultsSend', false, true);
    }

    // END: Cookie support.

    // TODO: Move to own error detection module, which can be disabled.
    // jsErrors(message, source, lineno, colno, error)
    o.OnError = function (e, source, lineno, colno, error) {
        var obj,
            e = e || '',
            message = '',
            source = source || '',
            lineno = lineno || 0,
            colno = colno || 0,
            error = error || '',
            stack = '',
            errorMaxLength = parseInt(GS('error.max.length') || 512, 10),
            errorMaxPerRequest = parseInt(GS('error.max.per.request') || 5, 10);

        // E can be an ErrorEvent with following props set:
        // e.error: TypeError: Cannot set property 'ignoreGlobalErrors' of undefined at http://localhost:8081/tests/unit/core.js:7:41
        // e.filename: "http://localhost:8081/tests/unit/core.js"
        // e.message: "Uncaught TypeError: Cannot set property 'ignoreGlobalErrors' of undefined"
        // e.lineno: 7
        // e.type: error
        if (e && (typeof e === 'function' || typeof e === 'object')) {
            if ('message' in e) message = e.message;
            if ('filename' in e && source === '') source = e.filename;
            if ('lineno' in e && lineno === 0) lineno = parseInt(e.lineno, 10);
            if ('colno' in e && colno === 0) colno = parseInt(e.colno, 10);
        }
        else if(e && (typeof e === 'string')) {
            message = e;
        }

        // Stack can be available if error object is set.
        if (error && (typeof error === 'function' || typeof error === 'object')) {
            if ('stack' in error) stack = error.stack;
        }

        obj = {
            'msg': TS(message, errorMaxLength),
            'source': TS(source, errorMaxLength),
            'lineno': lineno,
            'colno': colno,
            'stack': stack
        };

        // Only store errorMaxPerRequest error messages.
        if (o.jsErrors.length <= errorMaxPerRequest) {
            o.jsErrors.push(obj);
        }

        // Call original onerror handler if set.
        if (o.previousOnError) {
            o.previousOnError.apply(this, arguments);
        }

        o.AddLogMsg(JSON.stringify(obj), null, 'error');
        return true;
    };

    // Validate that browser version is high enough:
    // IE6+, FireFox: 15+ (2012-08-28), Chrome: 15+ (2011-10-25)
    if (b.ie && b.ie < 6) { return; }
    if (b.ff && b.ff < 15) { return; }
    if (b.chrome && b.chrome < 15) { return; }

    // Start monitoring:
    o.Reset();

    // Increase TotalFrame Counter in parent EUMJS object.
    if (o.IsFrameOfEumJs()) {
        o.id = IM('tf', 1);
    }

    // Store when the request (JS started), use the global cookie if set. (Will start 50-100 ms before our InitUEM code in some browsers).
    // TODO: Deprecated in future version.
    if (typeof g_uemJsStarted !== 'undefined') {
        jsst = g_uemJsStarted.getTime();
        o.AddLogMsg('Using g_uemJsStarted: ' + jsst);
    }

    // Set jsStarted on RootObject if it's null. (Frame updated after results was send)
    if (GM('jsStarted', true)) { 
        o.AddLogMsg('Setting jsStarted to: ' + jsst + " (Update parents: false)");
        SM('jsStarted', jsst, false);
    } else {
        o.AddLogMsg('Setting jsStarted to: ' + jsst + " (Update parents: true)");
        SM('jsStarted', jsst, true);
    }

    // Set default values.
    if (!GM('timeout')) { SM('timeout', 600); }
    if (!GM('asyncWait')) { SM('asyncWait', 600); }

    /**
     * Load settings from the script object and fills the o.settings array with the,.
     * Use GS and SS to Get and Set settings. (Always lowercase)
     * "key: 'APM', server: 'euem.saas.mcg.dk', hookAjax: true, hookAspNet: false, captureFullQuery: true"
     * TODO: Deprecated in future version.
     */
    function parseConfigString(str) {
        var cfgs = [],
            i,
            pos;

        if (str) { cfgs = str.split(', '); }
        var cfgsLength = cfgs.length;

        for (i = 0; i < cfgsLength; i++) {
            pos = cfgs[i].indexOf(':');
            if (pos >= 0) {
                SS(TS(cfgs[i].substring(0, pos)), TS(cfgs[i].substring(pos + 1, cfgs[i].length)));
            }
        }
    }

    /**
     * Get settings from script data-uem-config attribute.
     * <script src="apm_eumjs/apm_eumjs_core.js" data-uem-config="key: 'APM', server: 'euem.saas.mcg.dk', hookAjax: true, hookAspNet: false, captureFullQuery: true"></script>
     * TODO: Deprecated in future version.
     */
    function parseScriptDataAttribute() {
        var obj = d.getElementsByTagName('script'),
            scriptObj, j, cfg;
        var objLength = obj.length;

        if (obj && objLength > 0) {
            for (j = objLength - 1; j >= 0; j--) {
                scriptObj = obj[j];
                if ((scriptObj.src.search('uem') >= 0 || scriptObj.src.search('eum') >= 0 || scriptObj.src.search('uxm') >= 0) && scriptObj.attributes) {
                    cfg = scriptObj.attributes.getNamedItem('data-config') || scriptObj.attributes.getNamedItem('data-uem-config');

                    // FireFox 48: Brugen af attributtens nodeValue-attribut er udfaset. Brug value i stedet.
                    if (cfg && cfg.value) {
                        parseConfigString(cfg.value);
                    } else if (cfg && cfg.nodeValue) {
                        parseConfigString(cfg.nodeValue);
                    }
                    break;
                }
            }
        }
    }
    parseScriptDataAttribute();

    // IE Browser Plugin start.
    // C++ IE BHO will replace these values to set type, key, server, captureAjax, sendScreenSize.
    // SS('server', '{SERVER}');
    // SS('key', '{KEY}');
    // SS('isPlugin', true);
    // SS('captureAjax', '{CAPTUREAJAX}');
    // SS('sendScreenSize', '{SENDSCREENSIZE}');
    // SS('captureFullQuery', '{CAPTUREFULLQUERY}');
    // SS('ajaxSkipRegex', '{AJAXSKIPREGEX}');
	// SS('resourcesTop', '{RESOURCESTOP}');
	// SS('resourcesMinTime', '{RESOURCESMINTIME}');
	// SS('hostname', '{HOSTNAME}');
	// SS('machine_uuid', '{MACHINE_UUID}');
	// SS('node_key', '{NODE_KEY}');
	// SS('host_session_id', '{HOST_SESSION_ID}');
	// SS('username', '{USERNAME}');
    // IE Browser Plugin end.

    // Parse out global settings from ISAPI filter.
    /*if (typeof g_uemServerTime !== 'undefined') {
        SM('isapiServerTime', g_uemServerTime);

        // Debug: always send ISAPI server time, it can be 2 seconds where PerformanceTimings says 1 ms.
        SM('ispst', g_uemServerTime);
    }*/

    //if (typeof g_uemHttpCode !== 'undefined') { SM('isapiHttpCode', g_uemHttpCode); }
    //if( g_uemExtraInfo ) o.extraInfoFunc = g_uemExtraInfo;

    //Check if we have an cookie with the start time of this last action.
    parseRequestStartTimeCookie();

    // Check if document is already loaded or if we can hook into the loading process.
    o.AddLogMsg('checkIfDocumentIsAlreadyLoaded: ' + o.GetReadyState(d));
    if(o.GetReadyState(d) == 'complete') {
        onLoadEvent();
    }
    else {
        // Check when the MAIN html document is ready (all in head is loaded and DOM is ready for manipulation).
        // TODO: Should we use readystatechange or hookIntoDOMContentLoaded.
        if (b.ie) { o.Attach(document, 'readystatechange', onIE_ReadyStateChanged); }
        hookIntoDOMContentLoaded();

        o.Attach(window, 'load', onLoadEvent);
    }

    // Hook into errors if enabled.
    if(GS('error.capture', 'bool')) {
        // FireFox,Chrome,IE add stacktrace with onerror, it's missing in Attach(window, error).
        o.previousOnError = window.onerror;
        window.onerror = o.OnError;
    }

    // Attach to the load, unload and error events.
    o.Attach(window, 'beforeunload', OnBeforeUnLoadEvent);
    o.Attach(window, 'unload', OnUnLoadEvent);

    o.initialized = true;
}());/*jslint continue:true */
/*jslint plusplus: true */
/*jslint regexp: true */
/*global window, XMLHttpRequest */

// Basic XHR injection - Override the default XMLHttpRequest.prototype.open so we can trace XHR calls.
// Have dropped XHR support for IE5-8.
(function () {
    'use strict';

    // XHR not supported or XHR so old that it doesn't support addEventListener
    // (IE 6, 7, as well as newer running in quirks mode.)
    if (!window.XMLHttpRequest || !(new XMLHttpRequest()).addEventListener) {
        return;
    }

    var n = null,
        w = window,
        globalObjectName = window['McgUxmObj'] || 'uxm_web',
        apm = w[globalObjectName].core,
        GS = apm.GetSetting,
        captureXhr = apm.ParseBool(GS('hookAjax') || GS('captureAjax') || GS('xhr.capture') || true),
        captureFetch = apm.ParseBool(GS('fetch.capture') || false),
        captureXhrHeaders = (GS('xhr.capture.headers') || '').split(','),
        origXHR = w.XMLHttpRequest, // Save reference to earlier defined object implementation (if any)
        origFetch = null,
        origOpen = n,
        origAbort = n,
        requests = [],
        timeout = (GS('xhr.timeout') || 300) * 1000,
        xhrMinWaitTime = GS('ajaxMinWaitTime') || GS('xhr.minWaitTime') || 850,
        corsPolicy = GS('cors') || 'auto',
        lastXhrRequest = apm.GetMilliTimestamp(),
        UNSENT = 0,
        HEADERS_RECEIVED = 2,
        DONE = 4,
        TIMEOUT = 10;

    /**
     * Check each item in array if it matches searchFor. (Array is list of regular expressions)
     */
    function arrayContains(arr, searchFor) {
        var i,
            item;

        if (typeof searchFor !== "string") {
            return false;
        }
        if (!searchFor.indexOf || !searchFor.match) {
            return false;
        }

        // Remove query/hash, so we can match filename endings like .js$
        // We need full URL for ZenDesk, where it constantly polls a URL.
        // searchFor = searchFor.replace(/(\?.*)|(#.*)/g, "");

        for (i = 0; i <= arr.length; i++) {
            item = arr[i];
            if (typeof item !== "string" || item === "") {
                continue;
            }

            // apm.AddLogMsg('ajaxSkipRegex arrayContains: ' + searchFor + ', item: ' + item);
            if (searchFor.match(new RegExp(item, 'gi')) !== null) {
                return true;
            }
        }
        return false;
    }

    /**
     * returns true if no XHR calls are running.
     */
    function checkIfAllXhrCallsAreFinished() {
        var runningRequests = 0,
            now, idx, req, diff;

        // Wait X ms after last XHR called started, before giving finished status ok.
        // We can exclude XHR calls, but we have to await that all XHR calls are done, before sending total measure time.
        diff = apm.CalcResponseTime(lastXhrRequest);
        apm.AddLogMsg('checkIfAllXhrCallsAreFinished, last XHR called seen: ' + (diff) + ' ms ago (<= ' + xhrMinWaitTime + ' ms), waiting for more XHR calls.');
        if (lastXhrRequest > 0 && diff <= xhrMinWaitTime) {
            return false;
        }

        if (requests.length > 0) {
            now = apm.GetMilliTimestamp();

            // See if any of them reached a Timeout.
            for (idx in requests) {
                if (requests.hasOwnProperty(idx)) {
                    req = requests[idx];
                    diff = now - req.rs;

                    if (req.state < DONE && !req.aborted) {
                        if (diff > timeout) {
                            apm.AddLogMsg(req.id + ' - ' + req.url + ' timeout reached. ' + diff + ' > ' + timeout);
                            req.state = TIMEOUT;
                            calculateXhrMetrics(req);
                        }
                        if (req.state < DONE) { runningRequests = runningRequests + 1; }

                        apm.AddLogMsg(req.id + ' - ' + req.url + ' is still running.');
                    }
                }
            }
        }

        apm.AddLogMsg('checkIfAllXhrCallsAreFinished: ' + (runningRequests <= 0) + ', GetUrl: ' + apm.GetURL());
        return runningRequests <= 0;
    }

    /**
     * Calculate XHR metrics when request is done and send them to our MCG APM EUMJS object.
     * metrics = origXHR.prototype.mcgApmMetrics;
     */
    function calculateXhrMetrics(metrics) {
        if (metrics) {
            apm.AddLogMsg('Execute custom onreadystatechange code done: js: ' + metrics.js + ', ps: ' + metrics.ps + ', rs: ' + metrics.rs + ', js: ' + metrics.js);

            var time = apm.GetMilliTimestamp(),
                p = {
                    'start': metrics.rs,
                    'end': time,
                    'method': '',
                    'async': false,
                    'tt': 0,
                    'tp': 0,
                    'tf': 0,
                    'tcc': 0,
                    'type': metrics.type || 'xhr',
                    'ps': 0,
                    'status': '',
                    'headers': {}
                },
                r;

            if (metrics.ps > 0 && metrics.js > 0) {
                p.tf = apm.CalcDuration(metrics.ps, metrics.rs); // TimeFetching
                p.tp = apm.CalcDuration(metrics.js, metrics.ps); // TimeParsing
                p.tcc = apm.CalcDuration(time, metrics.js); // CustomCode, from JavaScript received untill calculateXhrMetrics is called.
            }
            p.duration = apm.CalcDuration(time, metrics.rs); // TotalTime including CustomCode, Network and everything.

            p.ps = metrics.cl; // Store the Content-Length under PageSize.
            p.headers = metrics.headers; // Store XHR headers fetched.
            p.url = metrics.url; // Store XHR url called.
            p.fullUrl = metrics.fullUrl;

            // Store Method (GET | POST | PUT) and if call was async.
            p.method = metrics.m;
            p.async = metrics.async === true ? 1 : 0;;

            // Set status to Aborted, so we can send Status HTTP Code 0~999 or Aborted in case of Timeouts/Move away from page.
            if (metrics.aborted === true) {
                metrics.status = 'Aborted';
            }
            else if (metrics.state === TIMEOUT) {
                metrics.status = 'Forced Timeout';
            }
            p.status = metrics.status;

            apm.AddLogMsg('XHR id: ' + metrics.id + ', call done, aborted: ' + metrics.aborted + ', status: ' + metrics.status + ', took: ' + p.duration + ' ms, CustomCode: ' + p.tcc + ' ms, ReqStarted: ' + metrics.rs + ', Url: ' + metrics.url);

            // Store the subrequests so we can see what took the time. (Only store in root EUMJS obj)
            r = apm.GetRootObj() || apm;
            r.subRequests[metrics.id + '_' + metrics.url] = p;

            // Force EUMJS to wait for sending the results x ms, to ensure all frames/xhr calls are done.
            apm.SetMetric('onAsyncEnded', time, true);
            r.SetCheckInQueue();
        }
    }

    /**
     * OnReadyStateChanged:
     */
    function OnReadyStateChanged() {
        var t = this,
            m = t.mcgApmMetrics,
            readyState = t.readyState;

        // Wait X ms after last XHR called changed status, before returning that all XHR calls are done.
        lastXhrRequest = apm.GetMilliTimestamp();

        // 2: request received = Time the server took to process the request (Including Network delays, etc)
        if (m) {
            m.state = readyState;

            // Get status code.
            try { m.status = this.status; } catch (e1) {}

            // Store the Client JS processing time (Step 2 -> 4).
            if (readyState === HEADERS_RECEIVED) { m.ps = apm.GetMilliTimestamp(); }

            if (readyState === DONE || m.aborted) {
                // Store the Client JS event handler execution time (Step 4 -> Custom code).
                m.js = apm.GetMilliTimestamp();

                // Check for the response size header and store the size.
                try {
					// Can cause Refused to get unsafe header "Content-Length" in console, if loading external resource, example: www.mcg.dk load XHR resource from cdn.mcg.dk.
					// Access-Control-Allow-Headers: origin, x-requested-with, content-type
					// Access-Control-Allow-Origin: http://cdn.mcg.dk
					// So allow users to disable it if needed.
					var l = window.location.origin;
					
					// Never try to load if Cors policy is off.
					if(corsPolicy === 'off') {}
					
					// Detect if url origin is the same and Content-Length can be called.
					// Skip if http/https is missing then it's a local resource.
					else if(corsPolicy === 'auto' && m.url.indexOf('http') >= 0 && m.url.indexOf(l) === -1) {
						//apm.OnError("WARNING: CORS-Policy violation, skipping getting Content-Length for " + m.url + ", loaded from " + l);
					}
					else {
                        if (t.getResponseHeader("Content-Length")) { m.cl = t.getResponseHeader("Content-Length"); }

                        // Try to load custom headers, defined via uxm_web('xhr.capture.headers', '...,...').
                        captureXhrHeaders.forEach(function (item, index) {
                            var key = item.trim();
                            if (key != "" && t.getResponseHeader(key)) {
                                m.headers[key] = t.getResponseHeader(key);
                            }
                        });
					}
                } catch (e2) {
                    apm.OnError("WARNING: XHR Content-Length parsing failed: " + apm.GetExceptionError(e2), '', 0);
                }
            }
        }

        // Calculate and send results when ReadyState = DONE (4).
        if (readyState === DONE || m.aborted) {
            calculateXhrMetrics(m);
        }
    }

    /***
     * Check if we are skipping these content types.
     * default: ".htc$ dynaTraceMonitor /adrum /rb_ keepalive", if ajaxSkipRegex isn't set in EUMJS script attribute config.
     *
     * dynaTrace: dynatraceMonitor + /rb_X
     * AppDynamics: /adrum
     */
    function skipXhrCall(sUrl) {
        var skip = (GS('ajaxSkipRegex') || GS('xhr.exclude.regex') || ".htc$ /adrum dynaTraceMonitor /rb_ keepalive transport=polling").split(" ");

        // Add the URL we send the data to.
        skip.push(GS('server'));

        if (skip && skip.length > 0 && sUrl.length >= 2 && arrayContains(skip, sUrl)) {
            apm.AddLogMsg('skipping: ' + sUrl + ' because its in xhr.exclude.regex: ' + skip.join());
            return true;
        }
        return false;
    }

    /**
     * Override open prototype function in XMLHttpRequest object, to trace when XHR requests are started.
     * this = XMLHttpRequest scope
     */
    function OpenHook(method, url, async) {
        var sMethod = method || "",
            sUrl = url || "",
            bAsync = async || false;

        // Skip files specified in xhr.exclude.regex and AVG2011 floods the Browser with XMLHttpPosts.
        if (!skipXhrCall(sUrl) && sUrl !== "/CC0227228D62/CheckData") {

			// Wait X ms after last XHR called started, before giving finished status ok.
			// We can exclude XHR calls, but we have to await that all XHR calls are done, before sending total measure time.
			// FIX: some systems is spamming with XHR/Socket.IO requests, expanding the wait for last xhr call > 850ms never get triggered.
			lastXhrRequest = apm.GetMilliTimestamp();

            //apm.AddLogMsg("HookXMLRequest open old id: ", this.metrics);
            apm.SetMetric('resultsSend', false, true);

            // Measure the performance of XHR calls.
            this.mcgApmMetrics = {
                'id': apm.IncreaseMetric('tac', 1),
                'state': 0,
                'url': sUrl,
                'm': sMethod,
                'async': bAsync,
                'rs': apm.GetMilliTimestamp(),
                'ps': 0,
                'js': 0,
                'cl': 0,
                'aborted': false,
                'status': 0,
                'headers': {}
            };

            apm.AddLogMsg("HookXMLRequest: id: " + this.mcgApmMetrics.id + " open url: " + sUrl + ", bAsync: " + bAsync);

            // Tell EUMJS that a XHR call was started, it will start monitoring again, if XHR call was caused by Mouse/Keyboard click after the page was loaded and results send.
            apm.AsyncInit(this.mcgApmMetrics.rs, this.mcgApmMetrics.id);

            // Store requests so we know how many is still running, and have timeout on each call, so we only wait for X seconds.
            requests.push(this.mcgApmMetrics);

            // Monitor changes to the ReadyState, so we can stop measuring when DONE(4) is received in readyState.
            this.addEventListener("readystatechange", OnReadyStateChanged, false);
        }

        return origOpen.apply(this, [].slice.call(arguments));
    }

    /**
     * Override abort prototype function in XMLHttpRequest object, to trace when XHR requests are aborted.
     * this = XMLHttpRequest scope
     */
    function AbortHook() {
        var m = this.mcgApmMetrics;

        // Set aborted = true so OnReadyStateChanged knows that the request is aborted, 
        // sometimes the OnReadyStateChanged is called after abort in CRM2015.
        if (m) {
            m.aborted = true;
            m.js = apm.GetMilliTimestamp();
        }

        calculateXhrMetrics(origXHR.prototype.mcgApmMetrics);
        return origAbort.apply(this, [].slice.call(arguments));
    }

    function FetchHook(_resource, _init) {

        function wrapCallBack(_promise, _fn, mcgApmFetchMetrics){
            return function(_response){
                for(var headerEntry of _response.headers.entries()){
                    if(headerEntry && Array.isArray(headerEntry) && headerEntry.length > 0){
                        var key = headerEntry[0].trim().toLowerCase();
                        if(key){
                            if( captureXhrHeaders.some( function(item){ return item && item.toString().toLowerCase() === key } ) )
                                mcgApmFetchMetrics.headers[key] = headerEntry.length > 1 ? headerEntry[1] || "" : "";
                        }
                    }
                };
                mcgApmFetchMetrics.js = apm.GetMilliTimestamp();
                mcgApmFetchMetrics.end = apm.GetMilliTimestamp();

                lastXhrRequest = apm.GetMilliTimestamp();
                console.log("Fetch metric: ", mcgApmFetchMetrics);

                mcgApmFetchMetrics.tt = apm.CalcDuration(mcgApmFetchMetrics.end, mcgApmFetchMetrics.start);
                mcgApmFetchMetrics.status = _response.status;
                mcgApmFetchMetrics.fullUrl = _response.url;
                calculateXhrMetrics(mcgApmFetchMetrics);

                var p = _fn.apply(_promise, arguments);
                return p;
            }
        }

        function wrapThen(_promise, _then, mcgApmFetchMetrics) {
            return function(){
                var args = Array.prototype.slice.call(arguments);
                if (args.length > 0) {
                    if (typeof args[0] === "function") {
                        args[0] = wrapCallBack(_promise, args[0], mcgApmFetchMetrics);
                        mcgApmFetchMetrics.state = DONE;
                    }
                    if (args.length > 1) {
                        if (typeof args[1] === "function") {
                            args[1] = wrapCallBack(_promise, args[1], mcgApmFetchMetrics);
                        }
                    }
                }

                mcgApmFetchMetrics["start"] = apm.GetMilliTimestamp();
                return _then.apply(_promise, args);
            }
        }

        _init = _init || {};
        var sUrl = arguments[0];
        var bAsync = true;

        // Request object can be send instead of URL string.
        if(typeof sUrl !== "string" && (typeof sUrl === "function" || typeof sUrl === "object")) {
            sUrl = arguments[0].url;
        }

        var promise = origFetch.apply(this, arguments);

        // Skip files specified in xhr.exclude.regex.
        if (!skipXhrCall(sUrl)) {

            // Wait X ms after last XHR called started, before giving finished status ok.
            // We can exclude XHR calls, but we have to await that all XHR calls are done, before sending total measure time.
            // FIX: some systems is spamming with XHR/Socket.IO requests, expanding the wait for last xhr call > 850ms never get triggered.
            lastXhrRequest = apm.GetMilliTimestamp();

            //apm.AddLogMsg("HookXMLRequest open old id: ", this.metrics);
            apm.SetMetric('resultsSend', false, true);

            // Measure the performance of XHR calls.
        
            var mcgApmFetchMetrics = {
                'id': apm.IncreaseMetric('tac', 1),
                'state': 0,
                'url': sUrl,
                'm': _init.method || 'GET',
                'async': bAsync,
                'rs': apm.GetMilliTimestamp(),
                'ps': 0,
                'js': 0,
                'cl': 0,
                'aborted': false,
                'status': 0,
                'type': 'fetch',
                'headers': {}
            };

            apm.AddLogMsg("HookFetch: id: " + mcgApmFetchMetrics.id + " open url: " + sUrl + ", bAsync: " + bAsync);

            // Tell EUMJS that a XHR call was started, it will start monitoring again, if XHR call was caused by Mouse/Keyboard click after the page was loaded and results send.
            apm.AsyncInit(mcgApmFetchMetrics.rs, mcgApmFetchMetrics.id);

            // Store requests so we know how many is still running, and have timeout on each call, so we only wait for X seconds.
            requests.push(mcgApmFetchMetrics);

            promise.then = wrapThen(promise, promise.then, mcgApmFetchMetrics);
        }
        return promise;
    }

    if (apm && apm.initialized && captureXhr === true) {

        //Override the XMLHttpRequest object to be able to monitor XHR requests in IE 5-11 / FireFox / Chrome.
        if (w.XMLHttpRequest && origXHR.prototype) {
            apm.AddLogMsg("Overriding XHR calls, alreadyOverridden: " + origXHR.prototype.mcgApmOverridden);

            if (!(typeof origXHR.prototype.mcgApmOverridden !== 'undefined')) {
                origXHR.prototype.mcgApmOverridden = true;
                origXHR.prototype.mcgApmMetrics = null;

                // Wrap around prototype functions.
                origOpen = origXHR.prototype.open;
                origXHR.prototype.open = OpenHook;

                origAbort = origXHR.prototype.abort;
                origXHR.prototype.abort = AbortHook;

                // Force APM EUMJS to call us when checking CheckIfPageIsCompletelyDone.
                apm.Subscribe('checkIfDone', checkIfAllXhrCallsAreFinished);

                // Unsubscribe when our frame is unloaded, or else we will receive IE Exception - "Can't execute code from a freed script when frame doesn't free it's handle".
                apm.Attach(w, 'unload', function () {
                    apm.Unsubscribe('checkIfDone', checkIfAllXhrCallsAreFinished);
                });
            }
        }
        
    }

    if (apm && apm.initialized && captureFetch === true) {
        //Override the fetch object to be able to monitor fetch requests in FireFox / Chrome / Edge.
        if (
		    // we don't check that fetch is a native function in case it was already wrapped
		    // by another vendor
		    typeof w.fetch !== "function" ||
		    // native fetch support will define these, some polyfills like `unfetch` will not
		    typeof w.Request !== "function" ||
		    typeof w.Response !== "function" ||
		    // native fetch needs Promise support
		    typeof w.Promise !== "function" ||
		    // if our window doesn't have fetch then it was probably polyfilled in the top window
		    typeof window.fetch !== "function" ||
		    // Github's `whatwg-fetch` polyfill sets this flag
		    w.fetch.polyfill) {
                // Skip fetch overriding.
		}
        else if (origFetch && origFetch === w.fetch) {
			// already instrumented
        }
        else {
            origFetch = w.fetch;
            w.fetch = FetchHook;
        }
    }
}());/*jslint continue:true */
/*jslint plusplus: true */
/*global window */

// Frames/iFrame support, MCG UXM Web script is normally injected into Frames, but we also try to get Performance of Frame that we ain't injectet into.
// There can be CORS errors if checking a external iframe.
(function () {
    'use strict';

    var globalObjectName = window['McgUxmObj'] || 'uxm_web',
        apm = window[globalObjectName].core,
        GS = apm.GetSetting,
        rootObj,
        totalFrames = 0, // Frames that are updated and which we can gather performance data from.
        maxFrames = 0, // Total frames found via iframe/frame tags in HTML.
        waitForFrames = (GS('waitForFrames') || 'frame_general').split(" "), // Wait for the MCG UXM Web to appear in these frames. (Work-around for MyMCS to detect when content is loaded).
        skipFrameNames = (GS('skipFrameNames') || 'reportViewerTouchSession').split(" "), // Skip frame names that contains these words.
        skipFrameURLs = (GS('skipFrameURLs') || '/Blank.aspx keepalive blank').split(" "); // Skip frame URLs that contains the words in the array.

    /**
     * Called before sending results, returning false will delay the result sending 1 second and stop other beforeSendResults hooks.
     */
    function beforeSendResultsFramesHook() {
        apm.SetMetric('tf', totalFrames);
        apm.SetMetric('mf', maxFrames);
        return true;
    }

    /**
     * Check if searchFor value ??
     * Only used in AJAX/Frame modules, maybe move to correct modules.
     */
    function arrayContains(arr, searchFor) {
        var i, item;
        if (typeof searchFor !== "string") { return false; }
        if (typeof (searchFor.indexOf) === 'undefined') { return false; }
        if (typeof (searchFor.toLocaleLowerCase) === 'undefined') { return false; }

        // Lowercase compare so we dont match case-sensitive.
        searchFor = searchFor.toLocaleLowerCase();

        for (i = 0; i <= arr.length; i++) {
            item = arr[i];
            if (typeof item !== "string") { continue; }

            item = item.toLocaleLowerCase();
            if (searchFor.indexOf(item) >= 0) {
                return true;
            }
        }
        return false;
    }

    // Only used in Frame modules.
    // Maybe move to correct modules.
    function arrayItemExists(arr, item) {
        var i;

        // IE7+ has indexOf.
        if (typeof arr.indexOf !== 'undefined') {
            //o.AddLogMsg('arrayItemExists: ' + arr.indexOf(item));
            return arr.indexOf(item) >= 0;

        } else if (typeof arr.length !== 'undefined') {
            for (i = 0; i <= arr.length; i++) {
                //o.AddLogMsg('arrayItemExists: ' + arr[i] + ' = ' + item);
                if (arr[i] === item) {
                    return true;
                }
            }
        }
        return false;
    }

    function createKey(id, name, path) {
        return 'frame_' + id + '_' + name + '_' + path;
    }

    /**
     * checkIfAllFramesAreFinished loops through all frames, CORS will cast exceptions if we are not allowed to get data out of frame.
     * win: Window to check frames in.
     * depth: We call ourself recursive, so keep track on how many times we have called us-self and break at 10 frames in frames.
     */
    function checkIfAllFramesAreFinished(win, depth, runningFrames) {
        var i, f, r, id, path, href, name, title, bReady, eumObj, pfObj, frames, p, frameTags = {},
            requestStarted = parseInt(apm.GetMetric('requestStarted') || 0, 10);

        win = win || window;
        depth = depth || 0;
        runningFrames = runningFrames || 0;

        // Reset TotalFrames counter if we are calling this check function again.
        if (depth === 0) {
            maxFrames = 0;
            totalFrames = 0;
        }

        if (!(win && win.frames)) {
            return true;
        }

        apm.AddLogMsg("checkIfAllFramesAreFinished: Depth: " + depth + " - Checking for running frames and storing response time from Frames without UXM Web agent in them.");

        // Try to get iframe ID/Name/Title so we can use them when reporting slow frames.
        // MS-CRM uses same name for most of it's charting frames.
        try {
            // Example CRM2011 iframe: <iframe id="Component17ecfda_vizIframe" title="Pipeline&amp;#32;des&amp;#32;ventes" scrolling="auto" frameborder="0" name="Component17ecfda_vizIframe" gridid="Component17ecfda" style="width: 100%; height: 100%; display: block;"></iframe>
            frames = win.document.getElementsByTagName("iframe");

            // Increase maxFrames so we know how many frames this page + sub pages contains.
            maxFrames += frames.length;

            for (name in frames) {
                if (frames.hasOwnProperty(name)) {
                    f = frames[name];
                    frameTags[f.id || name] = { 'name': name, 'id': f.id || '', 'title': decodeURIComponent(f.title || '') };
                }
            }

            frames = win.document.getElementsByTagName("frame");
            maxFrames += frames.length;
        } catch (e10) {}

        // We have seen security errors when trying to get ready state out.
        // Maybe they are caused be Cross-Referencing Domain Policy.
        try {
            for (i = 0; i < win.frames.length; i++) {

                f = eumObj = pfObj = null;
                id = path = href = name = title = bReady = '';

                try { if (win.frames[i]) { f = win.frames[i]; } } catch (e1) {}

                if (f) {
                    try { if (f.id) { id = f.id; } } catch (e2) {}
                    try {
                        if (f.location && f.location.pathname) {
                            path = f.location.pathname;
                            href = f.location.href;
                        }
                    } catch (e3) {}
                    try { if (f.name) { name = f.name; } } catch (e4) {}
                    try {
                        // Try to get frame settings form <iframe> tags, we lookup by the name. or id.
                        if (name !== "" && frameTags.hasOwnProperty(name)) {
                            id = frameTags[name].id;
                            title = frameTags[name].title;

                        } else if (id !== "" && frameTags.hasOwnProperty(id)) {
                            name = frameTags[id].name;
                            title = frameTags[id].title;
                        }
                    } catch (e5) {}
                    try { eumObj = f.McgAPM || f.g_mcgUemObj; } catch (e6) {}

                    apm.AddLogMsg("frame (depth: " + depth + ") id: " + id + ', name: ' + name + ', path: ' + path + ', title: ' + title);

                    // CRM Fix: Don't wait for the reportViewerTouchSession0 frame, it's set to update on a fixed timeout.
                    if (arrayContains(skipFrameNames, name)) {
                        apm.AddLogMsg("frame (depth: " + depth + ") id: " + id + ', name: ' + name + " skipping frame because it matches item in skipFrameNames.");
                        continue;
                    }

                    // CRM Fix: Don't wait for the _blank pages, causes issues in IE6.
                    if (arrayContains(skipFrameURLs, path)) {
                        apm.AddLogMsg("frame (depth: " + depth + ") id: " + id + ', path: ' + path + " skipping frame because it matches item in skipFrameURLs.");
                        continue;
                    }

                    try {
                        // Check if the readyState is not complete.
                        if (f.document) { bReady = apm.GetReadyState(f.document); }
                        if (f.contentWindow && f.contentWindow.document) { bReady = apm.GetReadyState(f.contentWindow.document); }

                    } catch (e7) {}

                    // Break if not ready, ignore if bReady couldn't be parsed out.
                    if (bReady !== 'complete' && bReady !== '') {
                        apm.AddLogMsg("frame (depth: " + depth + ") id: " + id + ', name: ' + name + ', path: ' + path + ', readyState: ' + bReady + ', MCG UXM Web obj: ' + eumObj);
                        runningFrames += 1;
                    }

                    // TMP: Fix for myMCS - Wait for the MCG EUEM object to be created.
                    // We only see frames when they have finished loading and the MCG UEM Obj is ready.
                    // TODO: Why do we need this? awaits McgApm in special Frames, the solution below that saves Frame data should be enough.
                    if (arrayItemExists(waitForFrames, name) && eumObj) {
                        apm.AddLogMsg("frame (depth: " + depth + ") id: " + id + ', name: ' + name + " found in waitForFrames, waiting for the MCG EUEM Agent to initialize.");
                        runningFrames += 1;
                    }

                    try {
                        pfObj = f.performance || f.msPerformance || f.mozPerformance;
                        apm.AddLogMsg('id: "' + id + '", name: "' + name + '", path: "' + path + '", title: "' + decodeURIComponent(title) + '" - Trying to gather frame performance information from: ' + pfObj + '.');

                        if (pfObj && apm.NavTimingAnalyze) {
                            apm.AddLogMsg('id: "' + id + '", name: "' + name + '", path: "' + path + '", title: "' + decodeURIComponent(title) + '" - Gather frame performance information.');
                            p = apm.NavTimingAnalyze(pfObj);
                            p.type = 'frame';
                            p.url = href;
                            p.title = title;

                            // Add to our RootObject.
                            // Ignore subrequests that are from before this result started.
                            if ((p.requestStarted - requestStarted) > -1000) {
                                r = apm.GetRootObj() || apm;
                                r.subRequests[createKey(id, name, path)] = p;

                                // Increase totalFrames so we know how many frames we have gathered data from.
                                totalFrames += 1;

                            } else {
                                apm.AddLogMsg('Frame was started ' + (p.requestStarted - requestStarted) + ' ms after main frame.', p, 'warn');
                            }
                        }
                    } catch (e8) { continue; }

                    if (eumObj) {
                        apm.AddLogMsg('Frame contains MCG UXM Web agent.');
                    }

                    if (depth <= 10) {
                        try { checkIfAllFramesAreFinished(f, depth + 1, runningFrames); } catch (e9) { continue; }
                    }
                }
            }
        } catch (err) {
            apm.OnError("WARNING: Waiting for Frames failed: " + apm.GetExceptionError(err), '', 0);
        }

        //apm.AddLogMsg('checkIfAllFramesAreFinished: ' + (runningFrames <= 0));
        return runningFrames <= 0;
    }

    if (apm && apm.initialized) {
        // Only run in main MCG UXM Web window, sub iFrames will be skipped.
        if (!apm.IsFrameOfEumJs()) {
            // Force APM MCG UXM Web to call us when checking CheckIfPageIsCompletelyDone, we only want to check the root frame, it can traverse all sub frames.
            apm.Subscribe('checkIfDone', checkIfAllFramesAreFinished);

            // Force APM MCG UXM Web to call us beforeSendingResults.
            apm.Subscribe('beforeSendResults', beforeSendResultsFramesHook);
        }
    }
}());/*global window */

// W3C Navigation Timing API. For more information about Navigation Timing, see: http://www.w3.org/TR/navigation-timing/.
// We await window.load and fills out the timings, the Navigation API can only be used for full page loads, will keep same values if user uses AJAX/AngularJS/iFrame to change pages.
// So clear values after usage.

// External resources:
//     All timing information is available if the Timing-Allow-Origin: * header i set on the server hosting the resource.
//     Only duration is set if resource is external.

// Supported Browsers:
// Chrome: 6.0+
// Firefox: 7.0+
// IE: 9.0+
// Opera: 15.0+
// Safari: 8.0+

(function (w, doc) {
    'use strict';

    var performance = w.performance || w.webkitPerformance || w.msPerformance || w.mozPerformance,
        isResourceTimingAvailable = performance && performance.getEntriesByType,
        globalObjectName = w['McgUxmObj'] || 'uxm_web',
        apm = w[globalObjectName].core,
        GM = apm.GetMetric,
        SM = apm.SetMetric,
        GS = apm.GetSetting,
        last = null,
        previousResources = GM('previousResources', true) || {}, // Resource timings are only valid after onLoad, frames can be updated afterswards (CRM), so store found objects and only include changed frames/resources.
        cachingTypes = {
            unknown: 0,
            cached: 1,
            validated: 2,
            fullLoad: 3
        },
        loadTypes = {
            unknown: 0,
            navigatenext: 1,
            reload: 2,
            back_forward: 3,
            prerender: 4
        };

    /**
     * Called before sending results, returning false will delay the result sending 1 second and stop other beforeSendResults hooks.
     */
    function beforeSendResultsNavTimingHook() {
        var allSlowItemsObj = GM('resourceEntries', false) || {},
            allSlowItemsArr = [],
            allNon2xxItemsArr = [],
            itemsArr,
            rootObj = apm.GetRootObj() || apm,
            item,
            key,
            jsonObj = {},
            arr = [],
            resourcesTop = parseInt(apm.GetSetting('resource.timings.capture.max') || apm.GetSetting('resourcesTop') || 25, 10);

        // Convert to array, sort and take top X slowest values.
        for (key in allSlowItemsObj) {
            if (allSlowItemsObj.hasOwnProperty(key)) {
                item = allSlowItemsObj[key];
                if ( (item.statusCode < 200) || (item.statusCode >=300) ){
                    allNon2xxItemsArr.push(item);
                } else {
                    allSlowItemsArr.push(item);
                }
            }
        }

        // Store the top $resMax ones, to avoid sending 100 slow resources.
        allSlowItemsArr.sort(function (a, b) {
            return b.duration - a.duration;
        });

        allSlowItemsArr = allSlowItemsArr.slice(0, Math.max(resourcesTop, 0));
		itemsArr = allSlowItemsArr.concat(allNon2xxItemsArr);

		// Send IMG, CSS, JS navigation timings.
        Object.keys(itemsArr).forEach(function (key) {
            item = itemsArr[key];
            arr = [item.offset, item.duration,
                    item.redirect, item.appcache, item.dns, item.tcp, item.ssl, item.request, item.response,
                    item.initiatorType, item.transferType, item.transferSize, item.encodedBodySize, item.decodedBodySize, item.ttfb, item.statusCode];

            jsonObj = {};
            jsonObj[apm.GetUrlWithoutCurrentPath(item.url)] = {'r': arr.join('|'), 'sc': item.statusCode};
            rootObj.timings[item.id + '_' + item.url] = jsonObj;
        });

        return true;
    }

    function isPositiveInteger(n) {
        return n >>> 0 === parseFloat(n);
    }

    /**
     * Calculate performance counters from PerformanceAPI.
     * Returns object with following variables: 
     * redirect: RedirectTime, 
     * dns: DNS Time, 
     * con: Connection Time, 
     * st: Server Time, 
     * dl: Download Time.
     */
    apm.NavTimingAnalyze = function (performanceObj) {
        var t,
            b = apm.GetBrowser(),
            resourcesMinTime = parseInt(apm.GetSetting('resource.timings.threshold.min') || apm.GetSetting('resourcesMinTime') || 50, 10),
            clearResourceTimings = apm.GetSetting('resource.timings.clear') || true,
            key,
            items,
            si,
            id,
            e,
            allSlowItems,
            p = {
                requestStarted: 0, // Unix timestamp used to calculate total time including xhr calls.
                unload: 0,
                appcache: 0,
                redirect: 0,
                dns: 0,
                tcp: 0,
                ssl: 0,
                request: 0,
                response: 0,
                dom: 0,
                children: 0,
                firstpaint: 0,
                firstcontentfulpaint: 0,
                statusCode: 0,
                tt: 0,
                timeOrigin: 0,
                redirectCount: 0,
                type: 0
            };

        if (performanceObj) {

            items = performanceObj.getEntriesByType('navigation');
            for (id in items) {
                if (items.hasOwnProperty(id)) {
                    t = items[id];
                    var tcpAndSsl = apm.CalculateTcpAndSsl(t.connectStart, t.connectEnd, t.secureConnectionStart);
                    p.unload = Math.round(t.unloadEventEnd - t.unloadEventStart);
                    p.appcache = Math.round(t.domainLookupStart - t.fetchStart);
                    p.redirect = Math.round(t.redirectEnd - t.redirectStart);
                    p.dns = Math.round(t.domainLookupEnd - t.domainLookupStart);
                    p.tcp = tcpAndSsl.tcp;
                    p.ssl = tcpAndSsl.ssl;
                    p.request = Math.round(t.responseStart - t.requestStart);
                    p.response = Math.round(t.responseEnd - t.responseStart);
                    p.dom = Math.round(t.domContentLoadedEventStart - t.domInteractive);
                    p.children = Math.round(t.loadEventEnd - t.domContentLoadedEventStart);
                    p.redirectCount = t.redirectCount;
                    p.type = t.type;

                    if (isPositiveInteger(t.responseStatus))
                        p.statusCode = t.responseStatus;

                    // Use this performance time for request started instead of the cookie.
                    // TODO: Use t.duration instead.
                    p.requestStarted = t.navigationStart || t.fetchStart || t.requestStart || undefined;
                    p.tt = t.responseStart - p.requestStarted;
                    
                    // New navigation timings store as seconds since load, old performance.timings stored as unix timestamps.
                    // Use timeOrigin to get when page loaded.
                    p.timeOrigin = performanceObj.timeOrigin;
                }
            }
            
            // Try to capture Paint timings.
            // Other browsers have them under:
            // window.performance.timing.msFirstPaint ? c = window.performance.timing.msFirstPaint : 'number' === typeof window.performance.timing.firstPaint && (c = window.performance.timing.firstPaint);
            items = performanceObj.getEntriesByType('paint');
            for (id in items) {
                if (items.hasOwnProperty(id)) {
                    e = items[id];
                    if (e.name === 'first-paint') {
                        p.firstpaint = Math.round(e.startTime);
                    } else if (e.name === 'first-contentful-paint') {
                        p.firstcontentfulpaint = Math.round(e.startTime);
                    }
                }
            }
        }

        // Try to gather information about scripts/images/css loadtimes. (only include those that are slow > resourcesMinTime)
        // Maybe move to beforeSendResults, to ensure everything is loaded.
        if (resourcesMinTime >= 0 && 'getEntriesByType' in performanceObj) {
            /*
            connectEnd: 0
            connectStart: 0
            domainLookupEnd: 0
            domainLookupStart: 0
            duration: 85.45499999999993
            entryType: "resource"
            fetchStart: 593.455
            initiatorType: "css"
            name: "http://static.jquery.com/files/rocker/images/logo_jquery_215x53.gif"
            redirectEnd: 0
            redirectStart: 0
            requestStart: 0
            responseEnd: 678.91
            responseStart: 0
            secureConnectionStart: 0
            startTime: 593.455
            workerStart: 0
            */
            items = performanceObj.getEntriesByType("resource");
            id = null;
            e = null;
            allSlowItems = GM('resourceEntries', false) || {};
			var resourcesStatusCodes = [];

            for (id in items) {
                if (items.hasOwnProperty(id)) {
                    var transferType = cachingTypes.unknown,
                        transferSize = 0,
                        encodedBodySize = 0,
                        decodedBodySize = 0;

                    e = items[id];

                    // Resources loaded locally or where header: Timing-Allow-Origin is set have size information.
                    // We can use this to check if img or script where cached, validated or fully loaded.
                    // Example on fully load: encodedBodySize: 103160, transferSize: 103417
                    // Note: Only works for Chrome and Firefox.
                    if (typeof e['transferSize'] === 'number' && typeof e['encodedBodySize'] === 'number' && e['encodedBodySize'] > 0) {
                        transferSize = e['transferSize'];
                        encodedBodySize = e['encodedBodySize'];
                        decodedBodySize = e['decodedBodySize'];

                        if (transferSize === 0) { transferType = cachingTypes.cached; }
                        else if (encodedBodySize > transferSize) { transferType =  cachingTypes.validated; }
                        else { transferType = cachingTypes.fullLoad; }
                    }
					
					var ttfb = "";
                    if (typeof e['responseStart'] === 'number' && typeof e['startTime'] === 'number') {                   
                        ttfb = apm.CalculateTiming(e['responseStart'], e['startTime'], false);
                    }                    
					
					// Status codes can only be captured by browser extensions.
					var resStatusCode = "";
					if (isPositiveInteger(e.responseStatus)) resStatusCode = e.responseStatus;

					//Force navigation timing to non 2xx resources: resStatusCode < 200 || resStatusCode >=300
                    if ( (e.duration >= resourcesMinTime) || (resStatusCode === "") || (resStatusCode < 200) || (resStatusCode >=300) ){
                        
                        var tcpAndSsl = apm.CalculateTcpAndSsl(e.connectStart, e.connectEnd, e.secureConnectionStart);

                        // Save as startTime | resourceType | durationMs | connectTime | domainTime | redirectTime | url
                        si = {
                            'id': id,
                            'gathered': apm.GetMilliTimestamp(),
                            'offset': Math.round(e.startTime),
                            'type': 'resource',
                            'initiatorType': e.initiatorType,
                            'duration': Math.round(e.duration),
                            'url': e.name,

                            'transferType': transferType,
                            'transferSize': transferSize,
                            'encodedBodySize': encodedBodySize,
                            'decodedBodySize': decodedBodySize,

                            'redirect': Math.round(e.redirectEnd - e.redirectStart),
                            'appcache': apm.CalculateTiming(e.domainLookupStart, e.fetchStart, false),
                            'dns': Math.round(e.domainLookupEnd - e.domainLookupStart),
                            'tcp': tcpAndSsl.tcp,
                            'ssl': tcpAndSsl.ssl,
							'ttfb': ttfb,							 
							'statusCode': resStatusCode,
                            'request': Math.round(e.responseStart - e.requestStart),
                            'response': apm.CalculateTiming(e.responseEnd, e.responseStart, true)
                        };
						
						// Set response timings to 0 if browser doesn't have access to read the resource timings. (Timing-Allow-Origin)
						if(e.responseStart <= 0) {
							si.response = 0
						}

                        // Check if resource already has been loaded before.
                        // Resource timings are updated onLoad, so when a sub frame reloads we can gather som extra information out.
                        key = [si.type, si.url, si.duration, si.tcp, si.dns, si.redirect].join('_');
                        if (!previousResources.hasOwnProperty(key)) {
                            allSlowItems[key] = si;
                        }
                        previousResources[key] = si.gathered;
                    }
                }
            }
            SM('resourceEntries', allSlowItems, false);
            SM('previousResources', previousResources, true);

            // Clear resources so we don't take them out again if frame or AJAX content loads.
            // Make custimizable so we don't interfere with other monitoring tools.
            // We could also switch to use new PerformanceObserver((entryList) => {} instead, see: https://web.dev/articles/ttfb
            if (clearResourceTimings) {
                performanceObj.clearResourceTimings();
            }
        }

        return p;
    };

    /* Try to collect traceId from server timing header */
    function getBackendTraceId() {
        var i,
            j,
            entry,
            serverTiming,
            entries = performance.getEntriesByType('navigation');

        if (!isResourceTimingAvailable) {
            return '';
        }

        for (i = 0; i < entries.length; i++) {
            entry = entries[i];

            if (entry['serverTiming'] != null) {
                for (j = 0; j < entry['serverTiming'].length; j++) {
                    serverTiming = entry['serverTiming'][j];

					// intid , for "INstana Trace IDentifier") response header to enable correlation with End-User Monitoring (EUM) for page loads
                    if (serverTiming['name'] === 'intid') {
						return serverTiming['description'];
                    }
					
					else if (serverTiming['name'] !== '') {
						return serverTiming['name'];
					}
                }
            }
        }
        return '';
    }
	
    function getNetworkTimings() {
        var networkTimings = {effectiveType:"", downlink: 0, rtt: 0};
        if (navigator && navigator.connection) {
            if(navigator.connection.effectiveType) {
                networkTimings.effectiveType = navigator.connection.effectiveType;
            }
            if(navigator.connection.downlink) {
                networkTimings.downlink = navigator.connection.downlink;
            }
            if(navigator.connection.rtt) {
                networkTimings.rtt = navigator.connection.rtt;
            }
        }        
        return networkTimings;
    }

    /**
     * Override o.metrics with values from the Performance API.
     * There is a 1 second delay before we send data, so this function will always execute before sending results.
     */
    function onLoadDone() {
        var p,
            nav,
            pt,
            toUTC = Number,
            now = apm.GetMilliTimestamp(),
            arr = [],
            traceId = getBackendTraceId();

		SM('network_timings', getNetworkTimings());

        if (performance) {

            p = apm.NavTimingAnalyze(performance);

            // TODO: Should we do this, we will loose the cookie start time if user clicked a link that redirects and JavaScript start time.
            if (p.timeOrigin !== undefined && p.timeOrigin > 0) {
                SM('requestStarted', p.timeOrigin);

                // TODO: 10 ms delay compared to Core onLoad function.
                // Generate onload time. dolt = DocumentOnLoadTime
                SM('dolt', now - p.timeOrigin);
                //SM('dolt', p.tt);
            }

            // Use the domEndTime if it's higher than the current set (AJAX/Frame events could change it).
            //if(t.domComplete && t.domComplete > 0) apm.onAsyncEnded = Math.max(apm.ConvertTimestampToUTC(t.domComplete), apm.onAsyncEnded);
            //if(t.domContentLoaded && t.domContentLoaded > 0) apm.onAsyncEnded = Math.max(apm.ConvertTimestampToUTC(t.domContentLoaded), apm.onAsyncEnded);

            // Override APM values, if they have changed.
            if (last && last.redirect === p.redirect && last.dns === p.dns && last.tcp === p.tcp &&
                last.request === p.request && last.response === p.response && last.dom === p.dom) {
                apm.AddLogMsg('PerformanceAPI returned same value, ignoring values');
                SM('ptig', 1);

            } else {
                SM('rt', apm.resultType.performanceTimings);

                // 2016-09-22 - Send full navigation timings, to debug strange times and show better waterfall / page info.
                try {
                    // Send Document Timing Metrics (dtm)
                    arr = [p.redirect, p.appcache, p.dns, p.tcp, p.ssl, p.request, p.response,
                        p.unload, p.dom, p.children, p.firstpaint, p.firstcontentfulpaint, '', p.tt];
                    SM('dtm', arr.join('|'));
                    SM('sc', p.statusCode);

                    // p.type:
                    // 0 = Navigation started by clicking on a link, or entering the URL in the user agent's address bar,
                    //		or form submission, or initializing through a script operation other than the ones
                    //		used by TYPE_RELOAD and TYPE_BACK_FORWARD as listed below.
                    // 1 = Navigation through the reload operation or the location.reload() method.
                    // 2 = Navigation through a history traversal operation.
                    if (p.type === 0 || p.type === "navigate") { SM('lt', loadTypes.navigatenext); }
                    if (p.type === 1 || p.type === "reload") { 
                        // Override the click identifier if a reload was performed.
                        apm.SetMetric('i', 'Reload', true);
                        SM('lt', loadTypes.reload);
                    }
                    if (p.type === 2 || p.type === "back_forward") { SM('lt', loadTypes.back_forward); }
                    if (p.type === "prerender") { SM('lt', loadTypes.prerender); }
                    if (p.redirectCount) { SM('rdc', p.redirectCount); }

                } catch (ex) {
                    apm.AddLogMsg('PerformanceAPI failed to gather full performance timings: ', ex);
                    apm.OnError("WARNING: failed to gather full performance timings: " + apm.GetExceptionError(ex), '', 0);
                }

                // 2019.11.21 - Takes to much bandwidth to send X count of timestamps, so calculate timings and send them.
            }

            last = p;
        }

        // Try to gather mobile information on Speed/Bandwidth.
        /*
            connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection || navigator.msConnection;
            connection.type |  connection.bandwidth | connection.metered
        */

        // Set backend TraceID from headers if not set in settings.
        if (traceId !== '' && GS('trace.id') === null) {
            SM('tid', traceId);
        }
    }

    if (apm && apm.initialized) {

        if(apm.GetReadyState(doc) === 'complete') {
            onLoadDone();
        }
        else {
            apm.Attach(w, 'load', function () {
                // If you want work with performance.timing.loadEventEnd, make sure to get it after the load event has ended.
                setTimeout(function () { onLoadDone(); }, 0);
            });
        }

        // Force APM EUMJS to call us beforeSendingResults.
        apm.Subscribe('beforeSendResults', beforeSendResultsNavTimingHook);

        // Unsubscribe when our frame is unloaded, or else we will receive IE Exception - "Can't execute code from a freed script when frame doesn't free it's handle".
        apm.Attach(w, 'unload', function () {
            apm.Unsubscribe('beforeSendResults', beforeSendResultsNavTimingHook);
        });
    }
}(window, document));/*global window, document, angular */

// Monitor on which objects the users clicks and which objects they uses onKeyPress -> Enter on.
(function () {
    'use strict';

    var globalObjectName = window['McgUxmObj'] || 'uxm_web';
    var apm = window[globalObjectName].core;

    /**
     * Returns the innerText of the object.
     * IE/Chrome has obj.innerText.
     * FireFox uses obj.textContent. (TextContent isen't available in IE8.
     */
    function getInnerText(obj) {
        if (obj) {
            return obj.innerText || obj.textContent;
        }
        return '';
    }

    function getAngularObjectInfo(obj, tag) {
        var ngClick, ngShow, parentNode, idx, j, classNames, className;

        // Only run if framework detected is angular.
        if (typeof angular === 'undefined') {
            return;
        }

        // Perform AngularJS/NG analysis if detected.
        ngClick = obj.getAttribute("ng-click") || '';
        if (ngClick !== '') {
            tag["ng-click"] = ngClick;
        }

        ngShow = obj.getAttribute("ng-show") || '';
        if (ngShow !== '') {
            tag["ng-show"] = ngShow;
        }

        // Get parent window or Card/Box. (Allow to go 25 parents back to detect it)
        parentNode = obj.parentNode;
        for (idx = 0; idx < 25; idx += 1) {
            if (parentNode) {
                if (parentNode.getAttribute && parentNode.tagName) {
                    // Check if it's an Dialog.
                    if ((parentNode.tagName.toLowerCase() === 'md-dialog' || parentNode.getAttribute("role") === 'dialog') && parentNode.getAttribute('class')) {
                        // Filter out mi-dialog, _md, md-transition-*
                        classNames = parentNode.getAttribute('class').split(' ');
                        for (j = 0; j < classNames.length; j += 1) {
                            if (classNames[j] !== 'mi-dialog' && classNames[j] !== '_md' && 
                                classNames[j].indexOf('md-transition-') !== 0 && classNames[j].indexOf('loading-') !== 0) {
                                className = classNames[j];
                                break;
                            }
                        }
                        tag["dialog"] = className;
                        break;
                    }

                    // Check if it's an card/box and use the tagName.
                    if (parentNode.getAttribute("webpart")) {
                        tag["webpart"] = parentNode.tagName.toLowerCase();
                        break;
                    }
                }
                parentNode = parentNode.parentNode;
            } else {
                break;
            }
        }
    }
	
	/**
	 * ReactJS has a structure where parent div className contains info about where on the page an item was clicked.
	 */
    function getParentDivWithClass(obj, tag) {
		var parentNode, idx, classNames, className;

		// Get parent div. (Allow to go 25 parents back to detect it)
        parentNode = obj.parentNode;
        for (idx = 0; idx < 25; idx += 1) {
            if (parentNode) {
                if (parentNode.getAttribute && parentNode.tagName) {
                    // Check if it's an Div with class attribute.
                    if (parentNode.tagName.toLowerCase() === 'div') {
						if(parentNode.getAttribute('class')) {
							classNames = parentNode.getAttribute('class').split(' ');
							if(classNames.length >= 1) {
								tag["parent-div-class"] = apm.TrimString(classNames[0], 50);
								break;
							}
						}
                        break;
                    }
                }
                parentNode = parentNode.parentNode;
            } else {
                break;
            }
		}
	}
	
    /**
     * Executed everytime a object is clicked in the document, used for setting a new pageRequest started cookie.
     */
    function onDocClick(e) {
        var obj = null,
            resultsSend = apm.GetMetric('resultsSend', true) || 0,
            tag = {},
            tagName = 'NA',
            innerText,
            command,
            tagStr,
            id = '',
            r;

        // Get the click element.
        if (e.target) {
            obj = e.target;
        } else if (e.srcElement) {
            obj = e.srcElement;
        }

        if (obj) {
            // Set event type.
            tag["event"] = "click";

            // Always use button if it's the previous object. (Many buttons contains icons that we don't want to identify on).
            if (obj.parentNode && obj.parentNode.tagName && obj.parentNode.tagName.toLowerCase() === 'button') {
                obj = obj.parentNode;
            }

            // Checks if jQuery is running:
            if (typeof jQuery != 'undefined') {
                // Figure out table that was click if using Dynamics.
                if(obj.getAttribute('class') && obj.getAttribute('class').indexOf('ms-') >= 0) {
                    //apm.SetSetting('metadata.header', $('.ms-Button-label').text());
                    //apm.SetSetting('metadata.grid', $("div[data-lp-id^='MscrmControls.']").attr('data-lp-id'));
                    tag["header"] = $('.ms-Button-label').text();
                    tag["grid"] = $("div[data-lp-id^='MscrmControls.']").attr('data-lp-id');
                }
            }

            if (typeof obj.tagName !== 'undefined') {
                tagName = apm.TrimString(obj.tagName, 50);
            }

            // Get the clicked text.
            innerText = apm.TrimString(getInnerText(obj), 50) || '';
            if (innerText !== '') {
                tag["text"] = innerText;
            }

            // Some websites uses aria-labels and hides the text in outer element.
            innerText = obj.getAttribute("aria-label") || '';
            if (innerText !== '') {
                tag["aria-label"] = innerText;
            }

            // Some websites uses aria-describedby on tables columns you click in.
            innerText = obj.getAttribute("aria-describedby") || '';
            if (innerText !== '') {
                tag["aria-describedby"] = apm.TrimString(innerText, 50);
            }
			
			// Older iframe based systems are using onclick javascript events.
			innerText = obj.getAttribute("onclick") || '';
            if (innerText !== '') {
                tag["onclick"] = apm.TrimString(innerText, 50);
            }

            // CRM stored button commands, eg. Save = lead|NoRelationship|Form|Mscrm.SavePrimary
            command = obj.getAttribute("command") || '';
            if (command !== '') {
                tag["command"] = command;
            }

            // Try id, name, title or img alt propperty if text is empty.
            if (typeof obj.id !== 'undefined' && obj.id !== '') {
                id = apm.TrimString(obj.id, 150);
                tag["id"] = id;

            } else if (typeof obj.name !== 'undefined' && obj.name !== '') {
                tag["name"] = apm.TrimString(obj.name, 150);
            }

            // Write title tag out if innerText was empty or no tags is set.
            if ((tag.length <= 0 || innerText === '') && typeof obj.title !== 'undefined' && obj.title !== '') {
                tag["title"] = apm.TrimString(obj.title, 50);
            }

            if (tag.length <= 0 && typeof obj.alt !== 'undefined' && obj.alt !== '') {
                tag["alt"] = apm.TrimString(obj.alt, 50);
            }

            getAngularObjectInfo(obj, tag);
			getParentDivWithClass(obj, tag);
        }

        var capture_identifiers = apm.GetSetting("identifiers.capture");
        if(capture_identifiers && capture_identifiers != "*"){
            capture_identifiers = capture_identifiers.split(",");
            var replaceKeys = [];
            Object.keys(tag).forEach(function(key){
                if(capture_identifiers.indexOf(key) < 0)
                    replaceKeys.push(key);
            });
            replaceKeys.forEach(function(key){
                tag[key] = "****";
            });
        }

        // Generate a JSON tag that contains text, id or name and title/alt if none other values was found.
        tagStr = JSON.stringify(tag);
        apm.AddLogMsg('onDocClick setting cookie, object: ' + tagName + ', TAG: ' + tagStr);

        // Use the innerText as identifier. (So we can see which buttons are clicked)
        // Only set if results are send ??, If user clicks on page while it's loading, identifier will be changed.
        if (resultsSend) {
            apm.SetMetric('i', tagStr, true);
            apm.SetMetric('last_click', tagStr, true);
        }

        // Check if the results are send, if not send them. (Check if we are a frame and are not supposed to send the results)
        apm.inAsyncWaitingState = false;

        // Set the RequestStartedTime and refurl cookie.
        apm.SetCookie('uxm_web_tag', tagStr, 1, '/', '');
        apm.SetCookie('uxm_web_prt', apm.GetMilliTimestamp(), 1, '/', '');
        apm.SetCookie('uxm_web_refurl', document.location, 1, '/', '');

        // Check if results needs to be send before clicking on link that could make AJAX call/iFrame update.
        if (!resultsSend) {
            r = apm.GetRootObj() || apm;
            r.SetCheckInQueue(true);
        }
    }

    function AttachEvents() {
        // Monitor all clicks in the document (MouseDown sometimes fires JSON/Ajax requests, 
		// we need to gather object that was clicked before the results are send).
        apm.Attach(document, 'click', onDocClick);
        apm.Attach(document, 'mousedown', onDocClick);
        //apm.Attach(document, 'mouseup', onDocClick);
        //apm.Attach(document, 'touchstart', onDocClick);
    }

    if (apm && apm.initialized) {
        if (apm.GetReadyState(document) === 'complete') {
            AttachEvents();
        }
        else {
            apm.Attach(window, 'load', AttachEvents);
        }
    }
}());

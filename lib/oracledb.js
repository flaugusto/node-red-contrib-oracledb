module.exports = function (RED) {
    "use strict";
    var oracledb = require("oracledb");
    var resolvePath = require("object-resolve-path");
    var events = require("events");
    var util = require("util");
    function initialize(node) {
        if (node.server) {
            node.status({ fill: "grey", shape: "dot", text: "unconnected" });
            //node.serverStatus = node.server.claimConnection();
            node.serverStatus = node.server.status;
            node.serverStatus.on("connecting", function () {
                node.status({ fill: "green", shape: "ring", text: "connecting" });
            });
            node.serverStatus.on("connected", function () {
                node.status({ fill: "green", shape: "dot", text: "connected" });
                //node.initialize();
            });
            node.serverStatus.on("closed", function () {
                node.status({ fill: "red", shape: "ring", text: "disconnected" });
            });
            node.serverStatus.on("error", function () {
                node.status({ fill: "red", shape: "dot", text: "connect error" });
            });
            node.serverStatus.on("reconnecting", function () {
                node.status({ fill: "red", shape: "ring", text: "reconnecting" });
            });
            node.on("close", function () {
                node.server.freeConnection();
            });
        }
        else {
            node.status({ fill: "red", shape: "dot", text: "error" });
            node.error("Oracle " + node.oracleType + " error: missing Oracle server configuration");
        }
    }
    //
    //-- Oracle DB -----------------------------------------------------------------
    //
    function OracleDb(n) {
        var node = this;
        RED.nodes.createNode(node, n);
        node.useQuery = n.usequery;
        node.query = n.query;
        node.useMappings = n.usemappings;
        try {
            node.mappings = n.mappings ? JSON.parse(n.mappings) : [];
        }
        catch (err) {
            node.error("Error parsing mappings: " + err.message);
            node.mappings = [];
        }
        node.resultAction = n.resultaction;
        node.resultLimit = n.resultlimit;
        node.server = RED.nodes.getNode(n.server);
        // set oracle node type initialization parameters
        node.oracleType = "storage";
        node.serverStatus = null;
        // node specific initialization code
        //node.initialize = function () {
	
	node.on("input", function (msg) {
            var values = [];
            var value;
            if (node.useMappings || (msg.payload && !util.isArray(msg.payload))) {
                // use mappings file to map values to array
                for (var i = 0, len = node.mappings.length; i < len; i++) {
                    try {
                        value = resolvePath(msg.payload, node.mappings[i]);
                    }
                    catch (err) {
                        value = null;
                    }
                    values.push(value);
                }
            }
            else {
                values = msg.payload;
            }
            var query;
            if (node.useQuery || !msg.query) {
                query = node.query;
            }
            else {
                query = msg.query;
            }
            var resultAction = msg.resultAction || node.resultAction;
            var resultSetLimit = parseInt(msg.resultSetLimit || node.resultLimit, 10);
    	    //customized by Icaro
    	    delete msg.query;
            node.server.query(node, query, values, resultAction, resultSetLimit, "sendResult", msg);
        });
        //};
        initialize(node);
    }
    //
    //-- Oracle server --------------------------------------------------------------
    //
    function OracleServer(n) {
        var node = this;
        RED.nodes.createNode(node, n);
        // Store local copies of the node configuration (as defined in the .html)
        node.host = n.host || "localhost";
        node.port = n.port || "1521";
        node.db = n.db || "orcl";
        node.reconnect = n.reconnect;
        node.reconnectTimeout = n.reconnecttimeout || 5000;
        node.queuedMaxLength = n.queuedMaxLength || 200;
        node.claimConnectionTime = 0;
        node.connectionInProgress = false;
        node.firstConnection = true;
        node.connection = null;
        node.connectString = "";
        node.queryQueue = [];
        node.user = node.credentials.user || "hr";
        node.password = node.credentials.password || "hr";
        node.status = new events.EventEmitter();
        node.status.setMaxListeners(0);
        node.claimConnection = function () {
            node.log("Connection claim started");
            if (!node.Connection && !node.connectionInProgress) {
                node.connectionInProgress = true;
                if (node.firstConnection) {
                    node.status.emit("connecting");
                }
                else {
                    node.status.emit("reconnecting");
                }
                node.firstConnection = false;
                // Create the connection for the Oracle server
                node.connectString = node.host + ":" + node.port + (node.db ? "/" + node.db : "");
                oracledb.getConnection({
                    user: node.user,
                    password: node.password,
                    connectString: node.connectString
                }, function (err, connection) {
                    node.connectionInProgress = false;
                    if (err) {
                        node.status.emit("error", err);
                        node.error("Oracle-server error connection to " + node.connectString + ": " + err.message);
                        // start reconnection process (retry connection claim)
                        if (node.reconnect && (node.claimConnectionTime < Date.now() - node.reconnectTimeout)) {
                            node.claimConnectionTime = Date.now();
                            node.log("Retry connection to Oracle server in " + node.reconnectTimeout + " ms");
                            node.reconnecting = setTimeout(node.claimConnection, node.reconnectTimeout);
                        }else{
                            node.log("Reconnect is activated? " + node.reconnect);
                            if(node.reconnect){
                                node.log("Retry connection to Oracle server in " + (node.reconnectTimeout - (Date.now() - node.claimConnectionTime)) + " ms");
                            }
                            //node.log("Trying to reconnect? " + node.hasOwnProperty("reconnecting"));
                        }
                    } else {
                        node.connection = connection;
                        node.status.emit("connected");
                        node.log("Connected to Oracle server " + node.connectString);
                        node.queryQueued();
                        delete node.reconnecting;
                    }
                });
            }
            return node.status;
        };
        node.freeConnection = function () {
            if (node.reconnecting) {
                clearTimeout(node.reconnecting);
                delete node.reconnecting;
            }
            if (node.connection) {
                node.connection.release(function (err) {
                    if (err) {
                        node.error("Oracle-server error closing connection: " + err.message);
                    }
                    node.connection = null;
                    node.status.emit("closed");
                    node.status.removeAllListeners();
                    node.log("Oracle server connection " + node.connectString + " closed");
                });
            }
        };
	    //customized by Icaro
        node.query = function (requestingNode, query, values, resultAction, resultSetLimit, sendResult, req_msg) {
            if (node.connection) {
                delete node.reconnecting;
                requestingNode.log("Oracle query execution started");

                //customized by Icaro
                if(req_msg.hasOwnProperty("oracledb_CLOB") && req_msg.oracledb_CLOB == "true"){
                    oracledb.fetchAsString = [ oracledb.CLOB ];
                }
                else{
                    oracledb.fetchAsString = [];
                }

                var options = {
                    autoCommit: true,
                    outFormat: oracledb.OBJECT,
                    maxRows: resultSetLimit,
                    resultSet: resultAction === "multi"
                };
                
                // values = req_msg.values || [];

                node.connection.execute(query, values, options, function (err, result) {

                    node.log("query: " + query);
                    if (err) {
                        requestingNode.error("Oracle query error: " + err.message, req_msg);
                        var errorCode = err.message.slice(0, 9);
                        node.status.emit("error", err);
                        if (errorCode === "ORA-03113" || errorCode === "ORA-03114") {
                            // start reconnection process
                            node.connection = null;
                            if (node.reconnect && (node.claimConnectionTime < Date.now() - node.reconnectTimeout)) {
                                node.log("Oracle server connection lost, retry in " + node.reconnectTimeout + " ms");
                                node.reconnecting = setTimeout(node.query, node.reconnectTimeout, requestingNode, query, values, resultAction, resultSetLimit, "sendResult", req_msg);
                            }else{
                                node.log("Reconnect is activated? " + node.reconnect);
                                if(node.reconnect){
                                    node.log("Retry connection to Oracle server in " + (node.reconnectTimeout - (Date.now() - node.claimConnectionTime)) + " ms");
                                }
                                //node.log("Trying to reconnect? " + node.hasOwnProperty("reconnecting"));
                            }
                        }
                    }
                    else {
                        switch (resultAction) {
                            case "single":
                                //customized by Icaro
                                req_msg.payload = result.outBinds || result.rows;
                                requestingNode.send(req_msg);
                                requestingNode.log("Oracle query single result rows sent");
                                break;
                            case "multi":
                                node.fetchRowsFromResultSet(requestingNode, result.resultSet, resultSetLimit, req_msg);
                                requestingNode.log("Oracle query multi result rows sent");
                                break;
                            default:
                                requestingNode.log("Oracle query no result rows sent");
                                break;
                        }
                    }
                });
            } else {
                requestingNode.log("Oracle query execution queued");
                //customized by Icaro
                if(node.queryQueue.length === node.queuedMaxLength){
                    node.queryQueue.shift();
                    requestingNode.log("Queued max length ("+node.queuedMaxLength+") exceeded, old entries shifted");
                }

                node.queryQueue.push({
                    requestingNode: requestingNode,
                    query: query,
                    values: values,
                    resultAction: resultAction,
                    resultSetLimit: resultSetLimit,
                    sendResult: "sendResult",
                    req_msg: req_msg
                });
                node.claimConnection();
            }
        };

        node.fetchRowsFromResultSet = function (requestingNode, resultSet, maxRows, req_msg) {
            resultSet.getRows(maxRows, function (err, rows) {
                if (err) {
                    requestingNode.error("Oracle resultSet error: " + err.message, req_msg);
                }
                else if (rows.length === 0) {
                    resultSet.close(function () {
                        if (err) {
                            requestingNode.error("Oracle error closing resultSet: " + err.message, req_msg);
                        }
                    });
                }
                else {
        	    //customized by Icaro
        	    req_msg.payload = rows;
                    requestingNode.send(req_msg); 
                    requestingNode.log("Oracle query resultSet rows sent");
                    node.fetchRowsFromResultSet(requestingNode, resultSet, maxRows, req_msg);
                }
            });
        };

        node.queryQueued = function () {
            while (node.connection && node.queryQueue.length > 0) {
                var e = node.queryQueue.shift();
                node.query(e.requestingNode, e.query, e.values, e.resultAction, e.resultSetLimit, e.sendResult, e.req_msg);
            }
        };
    }
    // Register the node by name. This must be called before overriding any of the
    // Node functions.
    //RED.nodes.registerType("oracle in", OracleIn);
    RED.nodes.registerType("oracledb", OracleDb);
    RED.nodes.registerType("oracle-server", OracleServer, {
        credentials: {
            user: { type: "text" },
            password: { type: "password" }
        }
    });
};

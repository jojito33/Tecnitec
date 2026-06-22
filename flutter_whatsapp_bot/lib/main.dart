import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'chatbot.dart';

const int HTTP_PORT = 3577;
const String EXPRESS_WS = 'ws://127.0.0.1:3000/ws';

Process? _engine;
HttpServer? _server;
WebSocket? _ws;
StreamSubscription? _engineStdout;
final List<Map> _msgQueue = [];

String _statusStr = 'DESCONECTADO';
String? _qrStr;
bool _conectado = false;
String? _phoneNumber;
String? _phoneName;

Future<void> main() async {
  // Spawn Node.js engine
  _spawnEngine();
  await _startHttpServer();
  _connectWebSocket();
  print('[Bot] Flutter WhatsApp Bot listo en puerto $HTTP_PORT');
}

void _spawnEngine() {
  // Find project root from exe path:
  // ...\flutter_whatsapp_bot\build\windows\x64\runner\Release\tecnitec_whatsapp_bot.exe
  // Go up directories to find the project root containing wa-engine.js
  // Exe: ...\flutter_whatsapp_bot\build\windows\x64\runner\Release\tecnitec_whatsapp_bot.exe
  // Go up 7 levels to reach project root
  String root = Platform.resolvedExecutable;
  Directory dir = Directory(root);
  for (int i = 0; i < 7; i++) {
    dir = dir.parent;
  }
  root = dir.path;
  final enginePath = '$root\\wa-engine.js';

  Process.start('node', [enginePath],
    workingDirectory: root,
    runInShell: true
  ).then((proc) {
    _engine = proc;
    print('[Bot] WA-Engine iniciado');

    _engineStdout = proc.stdout.transform(utf8.decoder).listen((line) {
      for (final l in line.split('\n')) {
        if (l.trim().isEmpty) continue;
        _handleEngineMessage(l.trim());
      }
    });

    proc.stderr.transform(utf8.decoder).listen((data) {
      print('[Bot-ERR] $data');
    });

    proc.exitCode.then((code) {
      print('[Bot] WA-Engine terminado con codigo $code');
      _engine = null;
      _statusStr = 'DESCONECTADO';
      _qrStr = null;
      _conectado = false;
      // Re-spawn after 3 seconds
      Future.delayed(const Duration(seconds: 3), _spawnEngine);
    });
  }).catchError((e) {
    print('[Bot] Error iniciando WA-Engine: $e');
    Future.delayed(const Duration(seconds: 5), _spawnEngine);
  });
}

void _sendEngine(String cmd, {Map? data}) {
  final msg = jsonEncode({ 'cmd': cmd, ...?data });
  _engine?.stdin.writeln(msg);
}

void _handleEngineMessage(String line) {
  Map msg;
  try {
    msg = jsonDecode(line) as Map;
  } catch (_) { return; }
  final cmd = msg['cmd'] as String?;

  if (cmd == 'qr') {
    _qrStr = msg['qr'] as String?;
    _wsSend({'tipo': 'wa_qr', 'qr': _qrStr});
  } else if (cmd == 'status') {
    _statusStr = msg['estado'] as String? ?? _statusStr;
    _conectado = _statusStr == 'LISTO';
    _wsSend({'tipo': 'wa_status', 'estado': _statusStr});
  } else if (cmd == 'ready') {
    _phoneNumber = msg['numero'] as String?;
    _phoneName = msg['nombre'] as String?;
    _conectado = true;
    _qrStr = null;
    _wsSend({'tipo': 'wa_ready', 'numero': _phoneNumber, 'nombre': _phoneName});
  } else if (cmd == 'disconnected' || cmd == 'desconectado') {
    _conectado = false;
    _qrStr = null;
    _phoneNumber = null;
    _phoneName = null;
    _wsSend({'tipo': 'wa_disconnected', 'razon': msg['razon'] ?? 'desconocido'});
  } else if (cmd == 'message') {
    final phone = (msg['from'] as String?) ?? '';
    final nombre = (msg['nombre'] as String?) ?? phone;
    final texto = (msg['texto'] as String?) ?? '';
    final ts = msg['timestamp'];
    if (texto.isNotEmpty) {
      _wsSend({
        'tipo': 'wa_message', 'from': phone, 'nombre': nombre,
        'texto': texto, 'ts': ts is int ? ts * 1000 : 0,
      });
      // Run chatbot logic
      _processChatbotMessage(phone, nombre, texto);
    }
  } else if (cmd == 'sent') {
    // Message sent confirmation
  } else if (cmd == 'error') {
    print('[Bot-Engine] Error: ${msg['msg']}');
  } else if (cmd == 'log') {
    print('[Bot-Engine] ${msg['msg']}');
  } else if (cmd == 'status_response') {
    _statusStr = msg['estado'] as String? ?? _statusStr;
    _conectado = msg['conectado'] == true;
    _qrStr = msg['qr'] as String?;
    _phoneNumber = msg['info'] is Map ? (msg['info']['numero'] as String?) : null;
    _phoneName = msg['info'] is Map ? (msg['info']['nombre'] as String?) : null;
  }
}

// HTTP Server
Future<void> _startHttpServer() async {
  _server = await HttpServer.bind(InternetAddress.anyIPv4, HTTP_PORT);
  await for (final req in _server!) {
    _handleRequest(req);
  }
}

void _handleRequest(HttpRequest req) {
  final path = req.uri.path;
  final method = req.method;

  if (method == 'GET' && path == '/status') {
    _jsonResponse(req, {
      'ok': true, 'connected': _conectado, 'status': _statusStr,
      'qr': _qrStr, 'phone': _phoneNumber,
    });
  } else if (method == 'POST' && path == '/connect') {
    _sendEngine('connect');
    _statusStr = 'INICIANDO';
    _jsonResponse(req, {'ok': true, 'msg': 'Conectando...'});
  } else if (method == 'POST' && path == '/disconnect') {
    _sendEngine('disconnect');
    _jsonResponse(req, {'ok': true});
  } else if (method == 'POST' && path == '/send') {
    _sendMessage(req);
  } else if (method == 'POST' && path == '/logout') {
    _sendEngine('logout');
    _jsonResponse(req, {'ok': true});
  } else {
    req.response.statusCode = 404;
    req.response.close();
  }
}

void _jsonResponse(HttpRequest req, Map body) {
  req.response.headers.contentType = ContentType.json;
  req.response.write(jsonEncode(body));
  req.response.close();
}

Future<void> _sendMessage(HttpRequest req) async {
  final body = await utf8.decodeStream(req);
  Map data;
  try { data = jsonDecode(body) as Map; } catch (_) {
    _jsonResponse(req, {'ok': false, 'error': 'JSON invalido'}); return;
  }
  final phone = data['numero'] as String?;
  final message = data['mensaje'] as String?;
  if (phone == null || message == null) {
    _jsonResponse(req, {'ok': false, 'error': 'numero y mensaje requeridos'}); return;
  }
  _sendEngine('send', data: {'numero': phone, 'mensaje': message});
  _jsonResponse(req, {'ok': true});
}

// WebSocket to Express
Future<void> _connectWebSocket() async {
  while (true) {
    try {
      _ws = await WebSocket.connect(EXPRESS_WS);
      print('[Bot] WebSocket conectado a Express');
      _ws!.listen(null, onError: (_) => _ws = null, onDone: () => _ws = null);
      for (final msg in _msgQueue) { _wsSendNow(msg); }
      _msgQueue.clear();
    } catch (_) {}
    await Future.delayed(const Duration(seconds: 3));
  }
}

void _wsSendNow(Map data) {
  if (_ws != null) {
    try { _ws!.add(jsonEncode(data)); } catch (_) {}
  }
}

void _wsSend(Map data) {
  if (_ws != null) { _wsSendNow(data); }
  else { _msgQueue.add(data); }
}

// Chatbot
Future<void> _processChatbotMessage(String phone, String name, String text) async {
  final respuesta = await chatbot.handleMessage(phone: phone, name: name, text: text);
  if (respuesta != null) {
    _sendEngine('send', data: {'numero': phone, 'mensaje': respuesta});
  }
}

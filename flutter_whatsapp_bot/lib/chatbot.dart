import 'dart:convert';
import 'dart:io';

const String API_BASE = 'http://127.0.0.1:3000';

class Chatbot {
  Future<String?> handleMessage({
    required String phone,
    required String name,
    required String text,
  }) async {
    final t = text.toLowerCase().trim();

    if (t == 'menu') {
      return _menuPrincipal(name);
    }
    if (t == '1' || t.contains('estado') || t.contains('seguimiento')) {
      return _consultarOrden(text);
    }
    if (t == '2' || t.contains('presupuesto')) {
      return _solicitarPresupuesto(phone, name, text);
    }
    if (t == '3' || t.contains('asesor')) {
      return _hablarAsesor();
    }

    return _menuPrincipal(name);
  }

  String _menuPrincipal(String name) {
    return 'Hola $name! Bienvenido a TECNITEC\n\n'
        'Como podemos ayudarte?\n\n'
        '1. Consultar estado de reparacion\n'
        '2. Solicitar presupuesto\n'
        '3. Hablar con un asesor\n\n'
        'Responde con el numero o la palabra clave';
  }

  Future<String> _consultarOrden(String text) async {
    final num = text.replaceAll('#', '').trim();
    if (!RegExp(r'^\d+$').hasMatch(num)) {
      return 'Envia el numero de orden que te dimos.\nEj: 123 o #123\n\n(MENU para volver)';
    }
    try {
      final client = HttpClient();
      final req = await client.getUrl(Uri.parse('$API_BASE/api/ordenes/$num'));
      req.headers.set('Authorization', 'Bearer chatbot');
      final res = await req.close();
      if (res.statusCode == 200) {
        final body = await res.transform(utf8.decoder).join();
        final data = jsonDecode(body);
        return 'Orden #$num encontrada\n'
            'Estado: ${data['estado'] ?? 'N/A'}\n'
            'Equipo: ${data['tipo_equipo'] ?? ''} ${data['marca'] ?? ''} ${data['modelo'] ?? ''}\n'
            'Presupuesto: \$${data['presupuesto'] ?? '0'}\n\n'
            '(MENU para volver)';
      } else {
        return 'Orden #$num no encontrada.\nVerifica el numero o escribe MENU';
      }
    } catch (_) {
      return 'Error consultando orden. Intenta de nuevo o escribe MENU';
    }
  }

  Future<String> _solicitarPresupuesto(String phone, String name, String text) async {
    try {
      final client = HttpClient();
      final req = await client.postUrl(Uri.parse('$API_BASE/api/chatbot/consultas/presupuesto'));
      req.headers.set('Content-Type', 'application/json');
      req.write(jsonEncode({
        'telefono': phone,
        'nombre': name,
        'descripcion': text,
      }));
      await req.close();
      return 'Consulta recibida!\n\n'
          'Un tecnico revisara tu caso y te enviara un presupuesto pronto.\n\n'
          '(MENU para volver)';
    } catch (_) {
      return 'Error al enviar consulta. Intenta de nuevo o escribe MENU';
    }
  }

  String _hablarAsesor() {
    return 'Te conectaremos con un asesor en breve.\n\n'
        'Describi tu consulta o escribe MENU para volver.';
  }
}

final chatbot = Chatbot();

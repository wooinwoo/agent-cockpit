import importlib.util
import pathlib
import unittest

spec = importlib.util.spec_from_file_location('proxy', pathlib.Path(__file__).resolve().parents[1] / 'scripts/jcode-stitch-proxy.py')
proxy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(proxy)


class SchemaCompatibility(unittest.TestCase):
    def test_removes_only_reference_annotations(self):
        schema = {'properties': {'screen': {'$ref': '#/$defs/Screen', 'description': 'Screen', 'maxProperties': 3}},
                  '$defs': {'Screen': {'type': 'object', 'description': 'Preserved', 'required': ['id']}}}
        fixed = proxy.normalize_schema(schema)
        self.assertEqual(fixed['properties']['screen'], {'$ref': '#/$defs/Screen', 'maxProperties': 3})
        self.assertEqual(fixed['$defs'], schema['$defs'])

    def test_tool_results_are_unchanged(self):
        reply = {'result': {'content': [{'type': 'text', 'text': 'private data'}]}}
        self.assertEqual(proxy.normalize_message(reply), reply)


if __name__ == '__main__':
    unittest.main()

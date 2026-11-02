import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from pip_fix import choose_version, is_direct, set_direct_pin, add_transitive_pin  # noqa: E402

NOW = datetime(2026, 10, 31, 2, 30, tzinfo=timezone.utc)
REPO = "example/pkg"


def c(version, published, repo=None):
    return {"version": version, "published_at": published, "provenance_repo": repo}


OLD = datetime(2026, 10, 1, tzinfo=timezone.utc)
REQ_IN = (Path(__file__).resolve().parents[3] / "services/pdf-extractor/requirements.in").read_text(encoding="utf8")


class ChooseVersion(unittest.TestCase):
    def test_minima_corretta(self):
        r = choose_version("0.5.0", ["<0.5.3"], [c("0.5.4", OLD), c("0.5.3", OLD), c("0.5.2", OLD)], [], NOW)
        self.assertEqual(r, {"action": "fix", "version": "0.5.3"})

    def test_pending_sotto_48h(self):
        pub = NOW - timedelta(hours=10)
        r = choose_version("0.5.0", ["<0.5.3"], [c("0.5.3", pub)], [], NOW)
        self.assertEqual(r["action"], "pending")
        self.assertEqual(r["eta"], pub + timedelta(hours=48))

    def test_provenienza_assente_dopo_precedente_attestata(self):
        r = choose_version("0.5.0", ["<0.5.3"], [c("0.5.3", OLD)], [c("0.5.0", OLD, REPO)], NOW)
        self.assertEqual(r, {"action": "unfixable", "reason": "provenienza assente o diversa"})

    def test_provenienza_diversa(self):
        r = choose_version("0.5.0", ["<0.5.3"], [c("0.5.3", OLD, "attacker/pkg")], [c("0.5.0", OLD, REPO)], NOW)
        self.assertEqual(r["action"], "unfixable")

    def test_mai_avuta_provenienza(self):
        r = choose_version("0.5.0", ["<0.5.3"], [c("0.5.3", OLD)], [c("0.5.0", OLD)], NOW)
        self.assertEqual(r, {"action": "fix", "version": "0.5.3"})

    def test_force_salta_eta_non_provenienza(self):
        young = NOW - timedelta(hours=1)
        self.assertEqual(choose_version("0.5.0", ["<0.5.3"], [c("0.5.3", young)], [], NOW, force_version="0.5.3"),
                         {"action": "fix", "version": "0.5.3"})
        r = choose_version("0.5.0", ["<0.5.3"], [c("0.5.3", young)], [c("0.5.0", OLD, REPO)], NOW, force_version="0.5.3")
        self.assertEqual(r["action"], "unfixable")

    def test_prerelease_esclusa_e_stessa_major_preferita(self):
        r = choose_version("1.9.0", ["<1.9.3"], [c("2.0.0", OLD), c("1.9.3rc1", OLD), c("1.9.3", OLD)], [], NOW)
        self.assertEqual(r, {"action": "fix", "version": "1.9.3"})

    def test_nessuna_corretta(self):
        r = choose_version("1.0.0", ["<2.0.0"], [c("1.5.0", OLD)], [], NOW)
        self.assertEqual(r, {"action": "unfixable", "reason": "nessuna versione corretta"})

    def test_data_sconosciuta(self):
        r = choose_version("1.0.0", ["<1.0.1"], [c("1.0.1", None)], [], NOW)
        self.assertEqual(r, {"action": "unfixable", "reason": "data di pubblicazione sconosciuta"})


class RequirementsIn(unittest.TestCase):
    def test_is_direct_normalizza_nome(self):
        self.assertTrue(is_direct(REQ_IN, "PyMuPDF"))
        self.assertTrue(is_direct(REQ_IN, "pymupdf"))
        self.assertTrue(is_direct(REQ_IN, "python_multipart"))
        self.assertTrue(is_direct(REQ_IN, "sentry-sdk"))
        self.assertFalse(is_direct(REQ_IN, "starlette"))

    def test_pin_diretto_aggiornato_extras_preservati(self):
        out = set_direct_pin(REQ_IN, "sentry-sdk", "2.73.1")
        self.assertIn("sentry-sdk[fastapi]==2.73.1\n", out)
        self.assertEqual(out.replace("2.73.1", "2.73.0"), REQ_IN)

    def test_pin_transitivo_commentato_in_fondo(self):
        out = add_transitive_pin(REQ_IN, "starlette", "1.10.1", ["GHSA-aaaa-bbbb-cccc"], "2026-10-31")
        self.assertTrue(out.startswith(REQ_IN))
        self.assertTrue(out.endswith(
            "# GHSA-aaaa-bbbb-cccc (2026-10-31, security-autofix): rimuovere quando il padre si aggiorna\n"
            "starlette==1.10.1\n"))

    def test_pin_transitivo_esistente_aggiornato(self):
        once = add_transitive_pin(REQ_IN, "starlette", "1.10.1", ["GHSA-a"], "2026-10-31")
        twice = add_transitive_pin(once, "starlette", "1.10.2", ["GHSA-b"], "2026-11-01")
        self.assertEqual(twice.count("starlette=="), 1)
        self.assertIn("starlette==1.10.2\n", twice)


class Apply(unittest.TestCase):
    def test_mai_downgrade_rispetto_al_lockfile(self):
        import tempfile
        from pip_fix import apply
        with tempfile.TemporaryDirectory() as d:
            Path(d, "requirements.in").write_text("fastapi==0.161.1\n", encoding="utf8")
            Path(d, "requirements.txt").write_text("urllib3==2.8.0 \\\n    --hash=sha256:00\n", encoding="utf8")
            with self.assertRaisesRegex(RuntimeError, "downgrade"):
                apply(d, "urllib3", "2.0.2", ["GHSA-x"], "2026-10-31")
            self.assertEqual(Path(d, "requirements.in").read_text(encoding="utf8"), "fastapi==0.161.1\n")


class Review(unittest.TestCase):
    def test_skip_versions_passa_alla_successiva(self):
        r = choose_version("0.5.0", ["<0.5.3"], [c("0.5.3", OLD), c("0.5.4", OLD)], [], NOW, skip_versions=["0.5.3"])
        self.assertEqual(r, {"action": "fix", "version": "0.5.4"})

    def test_changed_pins_solo_nuovi_o_cambiati(self):
        from pip_fix import changed_pins
        before = "a==1.0 \\\n    --hash=sha256:00\nb==2.0 \\\n    --hash=sha256:11\n"
        after = ("a==1.1 \\\n    --hash=sha256:22\nb==2.0 \\\n    --hash=sha256:11\n"
                 "c==3.0 \\\n    --hash=sha256:33\n")
        self.assertEqual(changed_pins(before, after), {"a": "1.1", "c": "3.0"})

    def test_young_pins_esclude_il_target(self):
        from pip_fix import young_pins
        times = {("a", "1.1"): NOW - timedelta(hours=100), ("c", "3.0"): NOW - timedelta(hours=2), ("t", "9"): NOW}
        self.assertEqual(young_pins({"a": "1.1", "c": "3.0", "t": "9"}, "t", lambda p, v: times[(p, v)], NOW), ["c==3.0"])

    def test_young_pins_data_sconosciuta_conta_come_giovane(self):
        from pip_fix import young_pins
        self.assertEqual(young_pins({"x": "1"}, "t", lambda p, v: None, NOW), ["x==1"])


if __name__ == "__main__":
    unittest.main()

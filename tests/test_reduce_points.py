import unittest
import numpy as np

from sam3d_funscript.core import remove_redundant_actions
from sam3d_funscript.processing_timeline import _assembled_actions


class ExactReductionTests(unittest.TestCase):
    def test_integer_cleanup_preserves_all_interpolated_values_and_boundaries(self):
        actions=[{'at':i*10,'pos':i if i<=50 else 50} for i in range(101)]
        output=remove_redundant_actions(actions,[250,355,700])
        self.assertEqual([p['at'] for p in output],[0,250,350,360,500,700,1000])
        times=np.arange(0,1000,.25)
        expected=np.interp(times,[p['at'] for p in actions],[p['pos'] for p in actions])
        actual=np.interp(times,[p['at'] for p in output],[p['pos'] for p in output])
        np.testing.assert_allclose(actual,expected,rtol=0,atol=1e-12)
        output[0]['pos']=20
        self.assertEqual(actions[0]['pos'],0)

    def test_integer_cross_products_keep_small_slope_changes_on_long_clips(self):
        offset=7_000_000_000_000_000
        actions=[{'at':offset+t,'pos':p} for t,p in [(0,0),(10,1),(20,2),(31,3),(40,4)]]
        self.assertEqual(remove_redundant_actions(actions),[actions[i] for i in (0,2,3,4)])
        self.assertEqual(remove_redundant_actions([{'at':0,'pos':10}]),[{'at':0,'pos':10}])

    def test_backend_assembly_removes_redundant_samples_and_pins_section_edges(self):
        script={'scripts':{'L0':{'actions':[{'at':i*10,'pos':50} for i in range(201)]}}}
        output=_assembled_actions([(0,1000,script),(1000,2000,script)],'L0',2000,200,'hold')
        self.assertLess(len(output),10)
        for at in [0,1000,1200,2000]:self.assertIn(at,[p['at'] for p in output])
        self.assertTrue(all(p['pos']==50 for p in output))

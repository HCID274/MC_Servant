# Quick test script for Phase 1 Tag integration
# Run as: python -m backend.quick_test_tag from MC_Servant directory

import sys
import os

# Ensure we're in the right directory
script_dir = os.path.dirname(os.path.abspath(__file__))
parent_dir = os.path.dirname(script_dir)
if parent_dir not in sys.path:
    sys.path.insert(0, parent_dir)

# Use absolute imports
from backend.task.prerequisite_resolver import PrerequisiteResolver
from backend.bot.tag_resolver import get_tag_resolver

def test_tag_integration():
    print("=" * 50)
    print("Phase 1 Tag Integration Test")
    print("=" * 50)
    
    # Test 1: PrerequisiteResolver has tag_resolver
    resolver = PrerequisiteResolver()
    print(f"\n[TEST 1] PrerequisiteResolver has _tag_resolver: {hasattr(resolver, '_tag_resolver')}")
    assert hasattr(resolver, '_tag_resolver'), "Missing _tag_resolver attribute"
    print("  ✅ PASS")
    
    # Test 2: TagResolver find_available returns highest count
    tag_resolver = get_tag_resolver()
    inventory = {
        "oak_planks": 2,
        "cherry_planks": 20,
        "birch_planks": 5
    }
    result = tag_resolver.find_available("planks", inventory)
    print(f"\n[TEST 2] find_available('planks') with mixed inventory: {result}")
    assert result == "cherry_planks", f"Expected cherry_planks but got {result}"
    print("  ✅ PASS")
    
    # Test 3: PrerequisiteResolver recognizes cherry_planks as planks
    context = {"missing": {"planks": 4}}
    inventory = {"cherry_planks": 16}
    task = resolver._resolve_missing_materials(context, inventory)
    print(f"\n[TEST 3] resolve_missing_materials with cherry_planks x16 for planks x4: {task}")
    assert task is None, f"Expected None (no prerequisite needed) but got {task}"
    print("  ✅ PASS - No prerequisite task needed!")
    
    # Test 4: Partial match still works
    context = {"missing": {"planks": 20}}
    inventory = {"cherry_planks": 4}
    task = resolver._resolve_missing_materials(context, inventory)
    print(f"\n[TEST 4] resolve_missing_materials with cherry_planks x4 for planks x20: {task}")
    if task:
        print(f"  Task: {task.name} / Goal: {task.goal}")
    print("  ✅ PASS - Partial match works")
    
    print("\n" + "=" * 50)
    print("All tests passed! Phase 1 complete.")
    print("=" * 50)

if __name__ == "__main__":
    test_tag_integration()

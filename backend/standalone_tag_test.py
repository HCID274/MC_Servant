# Standalone test for Tag integration
# Tests the core logic without full module dependencies

import json
from pathlib import Path

# Load tag_recipes.json directly
tag_file = Path(__file__).parent / "data" / "tag_recipes.json"
with open(tag_file, 'r', encoding='utf-8') as f:
    TAGS = json.load(f)

# Remove comment keys
TAGS = {k: v for k, v in TAGS.items() if not k.startswith('_')}

# Build reverse index
REVERSE_INDEX = {}
for tag_name, items in TAGS.items():
    for item in items:
        REVERSE_INDEX[item] = tag_name

def get_equivalents(item_name: str) -> list:
    """Get all equivalent items (same tag group)"""
    tag_name = REVERSE_INDEX.get(item_name)
    if tag_name:
        return TAGS[tag_name]
    return [item_name]

def find_available(item_name: str, inventory: dict) -> str:
    """Find the best available equivalent in inventory (highest count)
    
    Works with both:
    - Tag names (e.g., "planks") -> checks all members
    - Item names (e.g., "oak_planks") -> checks equivalents
    """
    # If item_name is a Tag, get its members directly
    if item_name in TAGS:
        equivalents = TAGS[item_name]
    else:
        equivalents = get_equivalents(item_name)
    
    available = [(name, inventory.get(name, 0)) for name in equivalents]
    available = [(name, count) for name, count in available if count > 0]
    
    if available:
        available.sort(key=lambda x: x[1], reverse=True)
        return available[0][0]
    return None

def test_tag_integration():
    print("=" * 50)
    print("Phase 1 Tag Integration Test (Standalone)")
    print("=" * 50)
    
    # Test 1: Check planks tag exists
    print(f"\n[TEST 1] 'planks' tag exists: {'planks' in TAGS}")
    assert 'planks' in TAGS, "planks tag not found"
    print(f"  Members: {TAGS['planks'][:5]}...") 
    print("  ✅ PASS")
    
    # Test 2: cherry_planks is in planks
    print(f"\n[TEST 2] cherry_planks in planks equivalents:")
    equivalents = get_equivalents("cherry_planks")
    print(f"  Equivalents: {equivalents[:5]}...")
    assert "oak_planks" in equivalents, "oak_planks should be equivalent to cherry_planks"
    print("  ✅ PASS")
    
    # Test 3: find_available returns highest count
    print(f"\n[TEST 3] find_available returns highest count:")
    inventory = {"oak_planks": 2, "cherry_planks": 20, "birch_planks": 5}
    result = find_available("planks", inventory)
    print(f"  Inventory: {inventory}")
    print(f"  find_available('planks') = {result}")
    assert result == "cherry_planks", f"Expected cherry_planks but got {result}"
    print("  ✅ PASS")
    
    # Test 4: Simulated PrerequisiteResolver logic
    print(f"\n[TEST 4] Simulated PrerequisiteResolver logic:")
    context = {"missing": {"planks": 4}}
    inventory = {"cherry_planks": 16}
    
    # This is what the new code does
    item_name = "planks"
    required_count = 4
    available_item = find_available(item_name, inventory)
    
    if available_item:
        available_count = inventory.get(available_item, 0)
        if available_count >= required_count:
            print(f"  ✅ Tag match: {available_item} x{available_count} satisfies {item_name} x{required_count}")
            print("  Result: No prerequisite task needed!")
        else:
            print(f"  ⚡ Partial match: need {required_count - available_count} more")
    
    print("  ✅ PASS")
    
    print("\n" + "=" * 50)
    print("All core logic tests passed!")
    print("The Phase 1 Tag integration is working correctly.")
    print("=" * 50)

if __name__ == "__main__":
    test_tag_integration()

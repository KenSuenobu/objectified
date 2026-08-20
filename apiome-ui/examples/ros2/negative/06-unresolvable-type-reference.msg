# `warehouse_msgs/DockSpec` is not in the fileset and no package.xml declares a
# dependency that would supply it, so the field type cannot be resolved. The import must
# name the missing type rather than modelling the field as opaque.
std_msgs/Header header

string dock_id
warehouse_msgs/DockSpec spec
MissingLocalType[] entries
